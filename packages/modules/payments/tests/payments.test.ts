import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { receiveInbound } from '@iaxti/module-conversations';
import { createPipeline, createDeal } from '@iaxti/module-crm';
import { createSimuladoProvider, flowSign } from '../domain/providers';
import {
  addProvider,
  cancelLink,
  createPaymentLink,
  expireLinks,
  listLinks,
  markLinkSent,
} from '../application/links';
import { confirmPayment } from '../application/confirm';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
let contacto: string;
let conversacion: string;
let deal: string;
let etapaPagado: string;

beforeAll(async () => {
  process.env.PAGOS_TEST_CRED = 'sandbox-cred';
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('payments-test') RETURNING id");
  tenant = t.rows[0].id;
  const res = await withTenant(admin, tenant, (c) =>
    receiveInbound(c, { tenantId: tenant, phone: '+56977770101', channel: 'simulador', body: 'quiero pagar' }),
  );
  contacto = res.contact.id;
  conversacion = res.conversation.id;
  const pipe = await withTenant(admin, tenant, (c) =>
    createPipeline(c, {
      tenantId: tenant,
      name: 'Ventas',
      stages: [
        { name: 'Cotizado', type: 'open' },
        { name: 'Pagado', type: 'open' },
        { name: 'Ganado', type: 'won' },
        { name: 'Perdido', type: 'lost' },
      ],
    }),
  );
  etapaPagado = pipe.stages.find((s) => s.name === 'Pagado')!.id;
  const d = await withTenant(admin, tenant, (c) =>
    createDeal(c, {
      tenantId: tenant,
      contactId: contacto,
      pipelineId: pipe.pipeline.id,
      title: 'Manicure mensual',
      value: 45000,
      actor: 'test',
    }),
  );
  deal = d.id;
});

afterAll(async () => {
  // Los links PAGADOS son inmutables (ni DELETE): quedan, igual que audit.
  await admin.query(`DELETE FROM payment_links WHERE tenant_id = $1 AND status <> 'paid'`, [tenant]);
  for (const tabla of ['deal_stage_history', 'deals', 'stages', 'pipelines', 'messages', 'conversations', 'contacts', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.end();
});

function proveedor() {
  return withTenant(admin, tenant, (c) =>
    addProvider(c, {
      tenantId: tenant,
      kind: 'simulado',
      name: 'Simulador',
      credentialRef: 'PAGOS_TEST_CRED',
      webhookSecretRef: 'PAGOS_TEST_SECRET',
      actor: 'test',
    }),
  );
}

describe('proveedores (#60)', () => {
  it('la firma de Flow es determinista (params en orden alfabético)', () => {
    const s = flowSign({ apiKey: 'k', amount: '1000', commerceOrder: 'abc' }, 'secreto');
    expect(s).toBe(flowSign({ commerceOrder: 'abc', apiKey: 'k', amount: '1000' }, 'secreto'));
    expect(s).toHaveLength(64);
  });

  it('credentialRef es un NOMBRE de env var — una credencial pegada se corta', async () => {
    await expect(
      withTenant(admin, tenant, (c) =>
        addProvider(c, {
          tenantId: tenant,
          kind: 'flow',
          name: 'Flow',
          credentialRef: 'apiKey:secretKey-real',
          actor: 'test',
        }),
      ),
    ).rejects.toThrow(/credencial/);
  });
});

describe('links (#60)', () => {
  it('el monto sale de la oportunidad si no viene escrito, y queda created', async () => {
    await proveedor();
    const link = await withTenant(admin, tenant, (c) =>
      createPaymentLink(c, {
        tenantId: tenant,
        contactId: contacto,
        conversationId: conversacion,
        dealId: deal,
        concept: 'Manicure mensual',
        actorUserId: randomUUID(),
      }),
    );
    expect(link.amountClp).toBe(45000); // el value_clp del deal
    expect(link.status).toBe('created');
    expect(link.url).toContain('pagos-simulados');

    await withTenant(admin, tenant, (c) => markLinkSent(c, { tenantId: tenant, linkId: link.id }));
    const lista = await withTenant(admin, tenant, (c) =>
      listLinks(c, tenant, { conversationId: conversacion }),
    );
    expect(lista[0].status).toBe('sent');
  });

  it('el tope del USER corta ANTES de llamar al proveedor', async () => {
    await expect(
      withTenant(admin, tenant, (c) =>
        createPaymentLink(c, {
          tenantId: tenant,
          contactId: contacto,
          amountClp: 500000,
          concept: 'Cobro grande',
          maxAmountClp: 100000,
          actorUserId: randomUUID(),
        }),
      ),
    ).rejects.toThrow(/tope/);
  });

  it('vencimiento: created/sent con fecha pasada quedan expired con evento', async () => {
    const link = await withTenant(admin, tenant, (c) =>
      createPaymentLink(c, {
        tenantId: tenant,
        contactId: contacto,
        amountClp: 10000,
        concept: 'Se vence',
        actorUserId: randomUUID(),
      }),
    );
    await admin.query(`UPDATE payment_links SET expires_at = now() - interval '1 hour' WHERE id = $1`, [link.id]);
    const vencidos = await withTenant(admin, tenant, (c) => expireLinks(c, tenant));
    expect(vencidos).toBe(1);
    const evento = await admin.query(
      `SELECT count(*)::int AS n FROM outbox WHERE tenant_id = $1 AND name = 'payment_link.expired'`,
      [tenant],
    );
    expect(evento.rows[0].n).toBe(1);
  });

  it('cancelar funciona en created/sent; dos veces no', async () => {
    const link = await withTenant(admin, tenant, (c) =>
      createPaymentLink(c, {
        tenantId: tenant,
        contactId: contacto,
        amountClp: 5000,
        concept: 'Para cancelar',
        actorUserId: randomUUID(),
      }),
    );
    await withTenant(admin, tenant, (c) => cancelLink(c, { tenantId: tenant, linkId: link.id, actor: 'test' }));
    await expect(
      withTenant(admin, tenant, (c) => cancelLink(c, { tenantId: tenant, linkId: link.id, actor: 'test' })),
    ).rejects.toThrow(/no se puede/);
  });
});

describe('confirmación (#61)', () => {
  it('el pago marca paid, registra Payment, avisa al chat y mueve el deal', async () => {
    const link = await withTenant(admin, tenant, (c) =>
      createPaymentLink(c, {
        tenantId: tenant,
        contactId: contacto,
        conversationId: conversacion,
        dealId: deal,
        concept: 'Manicure mensual',
        actorUserId: randomUUID(),
      }),
    );
    const res = await withTenant(admin, tenant, (c) =>
      confirmPayment(c, {
        tenantId: tenant,
        linkId: link.id,
        status: 'paid',
        method: 'webpay',
        providerPaymentId: 'sim-777',
        receiptUrl: 'https://comprobante.simulado/777',
        paidStageName: 'Pagado',
      }),
    );
    expect(res.outcome).toBe('paid');

    const pago = await admin.query('SELECT * FROM payments WHERE tenant_id = $1 AND link_id = $2', [tenant, link.id]);
    expect(Number(pago.rows[0].amount_clp)).toBe(45000);
    expect(pago.rows[0].method).toBe('webpay');

    const msg = await admin.query(
      `SELECT body FROM messages WHERE tenant_id = $1 AND conversation_id = $2 AND direction = 'out'
        ORDER BY seq DESC LIMIT 1`,
      [tenant, conversacion],
    );
    expect(msg.rows[0].body).toContain('Pago recibido');
    expect(msg.rows[0].body).toContain('comprobante.simulado');

    const d = await admin.query('SELECT stage_id FROM deals WHERE id = $1', [deal]);
    expect(d.rows[0].stage_id).toBe(etapaPagado);

    const evento = await admin.query(
      `SELECT payload FROM outbox WHERE tenant_id = $1 AND name = 'payment.received'`,
      [tenant],
    );
    expect(evento.rows[0].payload.amountClp).toBe(45000);

    // Idempotente: el mismo webhook otra vez no duplica nada.
    const otraVez = await withTenant(admin, tenant, (c) =>
      confirmPayment(c, { tenantId: tenant, linkId: link.id, status: 'paid' }),
    );
    expect(otraVez.outcome).toBe('already');
    const pagos = await admin.query('SELECT count(*)::int AS n FROM payments WHERE link_id = $1', [link.id]);
    expect(pagos.rows[0].n).toBe(1);

    // Un link pagado es INMUTABLE: ni update ni delete.
    await expect(
      admin.query(`UPDATE payment_links SET concept = 'hackeado' WHERE id = $1`, [link.id]),
    ).rejects.toThrow(/inmutable/);
    await expect(admin.query('DELETE FROM payment_links WHERE id = $1', [link.id])).rejects.toThrow(/inmutable/);
  });

  it('el webhook simulado se verifica por HMAC y la basura no pasa', () => {
    const port = createSimuladoProvider();
    const body = JSON.stringify({ linkId: 'abc', status: 'paid' });
    const firma = createHmac('sha256', 'secreto').update(body).digest('hex');
    expect(port.verifyWebhook(body, { 'x-iaxti-pay-signature': firma }, 'secreto')).toBe(true);
    expect(port.verifyWebhook(body, { 'x-iaxti-pay-signature': 'chamullo' }, 'secreto')).toBe(false);
    expect(port.parseWebhook('no-json')).toBeNull();
    expect(port.parseWebhook(body)?.status).toBe('paid');
  });
});
