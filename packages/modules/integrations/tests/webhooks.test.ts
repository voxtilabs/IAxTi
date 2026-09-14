import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { MAX_ATTEMPTS, backoffMinutes, signPayload, verifySignature } from '../domain/signing';
import {
  createEndpoint,
  deliverWebhooks,
  enqueueDeliveries,
  listDeliveries,
  listEndpoints,
  retryDelivery,
  rotateSecret,
} from '../application/webhooks';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

const CATALOGO = new Set(['deal.won', 'payment.received', 'conversation.created']);

let admin: Pool;
let tenant: string;
let otroTenant: string;

function eventoFalso(id: number, name = 'deal.won', tenantId = tenant) {
  return {
    id,
    name,
    tenantId,
    payload: { dealId: 'd-1', valueClp: 45000 },
    actor: 'system',
    requestId: null,
    version: 1,
    occurredAt: new Date(),
  } as never;
}

async function encolar(id: number, name?: string, tenantId?: string) {
  const client = await admin.connect();
  try {
    await enqueueDeliveries(eventoFalso(id, name, tenantId), client);
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('webhooks-test') RETURNING id");
  tenant = t.rows[0].id;
  const t2 = await admin.query("INSERT INTO tenants (name) VALUES ('webhooks-otro') RETURNING id");
  otroTenant = t2.rows[0].id;
});

afterAll(async () => {
  for (const tid of [tenant, otroTenant]) {
    await admin.query(`DELETE FROM webhook_deliveries WHERE tenant_id = $1`, [tid]);
    await admin.query(`DELETE FROM webhook_endpoints WHERE tenant_id = $1`, [tid]);
    await admin.query(`DELETE FROM outbox WHERE tenant_id = $1`, [tid]);
  }
  await admin.end();
});

describe('firma (#76)', () => {
  it('firma y verificación de referencia calzan; el tiempo viejo no pasa', () => {
    const firma = signPayload('whsec_x', '{"a":1}');
    expect(verifySignature('whsec_x', '{"a":1}', firma)).toBe(true);
    expect(verifySignature('whsec_OTRO', '{"a":1}', firma)).toBe(false);
    expect(verifySignature('whsec_x', '{"a":2}', firma)).toBe(false);
    const vieja = signPayload('whsec_x', '{"a":1}', Math.floor(Date.now() / 1000) - 3600);
    expect(verifySignature('whsec_x', '{"a":1}', vieja)).toBe(false); // fuera de tolerancia
    expect(backoffMinutes(1)).toBe(1);
    expect(backoffMinutes(6)).toBe(32);
  });
});

describe('suscripciones y entregas (#76)', () => {
  it('crea con eventos del catálogo (los piratas no), y el secreto rota', async () => {
    await expect(
      withTenant(admin, tenant, (c) =>
        createEndpoint(c, {
          tenantId: tenant,
          url: 'https://cliente.cl/hooks',
          events: ['meteorito.cayo'],
          catalog: CATALOGO,
          actor: 'test',
        }),
      ),
    ).rejects.toThrow(/catálogo/);

    const ep = await withTenant(admin, tenant, (c) =>
      createEndpoint(c, {
        tenantId: tenant,
        url: 'https://cliente.cl/hooks',
        events: ['deal.won', 'payment.received'],
        catalog: CATALOGO,
        actor: 'test',
      }),
    );
    expect(ep.secret).toMatch(/^whsec_/);

    const rotado = await withTenant(admin, tenant, (c) =>
      rotateSecret(c, { tenantId: tenant, endpointId: ep.id, actor: 'test' }),
    );
    expect(rotado.secret).not.toBe(ep.secret);
  });

  it('el consumer encola SOLO eventos suscritos del tenant dueño, idempotente', async () => {
    await encolar(1001, 'deal.won');
    await encolar(1001, 'deal.won'); // el mismo evento dos veces
    await encolar(1002, 'conversation.created'); // no suscrito
    await encolar(1003, 'deal.won', otroTenant); // otro tenant sin endpoints

    const entregas = await withTenant(admin, tenant, (c) => listDeliveries(c, tenant));
    expect(entregas).toHaveLength(1); // solo deal.won, una vez
    expect(entregas[0].eventName).toBe('deal.won');
    const ajenas = await withTenant(admin, otroTenant, (c) => listDeliveries(c, otroTenant));
    expect(ajenas).toHaveLength(0); // jamás cross-tenant
  });

  it('entrega FIRMADA con 200; el fallo reintenta con backoff y agota en failed', async () => {
    const capturadas: Array<{ url: string; firma: string; body: string }> = [];
    const fetch200: typeof fetch = async (url, init) => {
      capturadas.push({
        url: String(url),
        firma: String((init?.headers as Record<string, string>)['X-Iaxti-Signature']),
        body: String(init?.body),
      });
      return new Response('ok', { status: 200 });
    };
    const res = await deliverWebhooks(admin, fetch200);
    expect(res.delivered).toBe(1);
    const [cap] = capturadas;
    const ep = (await withTenant(admin, tenant, (c) => listEndpoints(c, tenant)))[0];
    expect(verifySignature(ep.secret, cap.body, cap.firma)).toBe(true); // firma real
    expect(JSON.parse(cap.body).data.valueClp).toBe(45000);

    // Un evento nuevo contra un servidor caído: reintenta y agota.
    await encolar(1004, 'payment.received');
    const fetch500: typeof fetch = async () => new Response('boom', { status: 500 });
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await admin.query(
        `UPDATE webhook_deliveries SET next_retry_at = now() WHERE tenant_id = $1 AND status = 'pending'`,
        [tenant],
      );
      await deliverWebhooks(admin, fetch500);
    }
    const fallida = (await withTenant(admin, tenant, (c) => listDeliveries(c, tenant))).find(
      (d) => d.eventName === 'payment.received',
    )!;
    expect(fallida.status).toBe('failed');
    expect(fallida.attempt).toBe(MAX_ATTEMPTS);
    expect(fallida.responseStatus).toBe(500);

    // Reintento manual: vuelve a pending y entrega cuando el server sana.
    await withTenant(admin, tenant, (c) =>
      retryDelivery(c, { tenantId: tenant, deliveryId: fallida.id }),
    );
    const res2 = await deliverWebhooks(admin, fetch200);
    expect(res2.delivered).toBe(1);
  });

  it('falla sostenida >24 h: el endpoint se APAGA con webhook.failed', async () => {
    // Forzamos el reloj: failing_since hace 25 horas y una entrega al borde.
    const ep = (await withTenant(admin, tenant, (c) => listEndpoints(c, tenant)))[0];
    await admin.query(
      `UPDATE webhook_endpoints SET failing_since = now() - interval '25 hours' WHERE id = $1`,
      [ep.id],
    );
    await encolar(1005, 'deal.won');
    await admin.query(
      `UPDATE webhook_deliveries SET attempt = $2, next_retry_at = now()
        WHERE tenant_id = $1 AND status = 'pending'`,
      [tenant, MAX_ATTEMPTS - 1],
    );
    const fetch500: typeof fetch = async () => new Response('boom', { status: 500 });
    await deliverWebhooks(admin, fetch500);

    const apagado = (await withTenant(admin, tenant, (c) => listEndpoints(c, tenant)))[0];
    expect(apagado.active).toBe(false);
    expect(apagado.disabledReason).toContain('sostenido');
    const evento = await admin.query(
      `SELECT payload FROM outbox WHERE tenant_id = $1 AND name = 'webhook.failed'`,
      [tenant],
    );
    expect(evento.rows[0].payload.endpointId).toBe(ep.id);
  });
});
