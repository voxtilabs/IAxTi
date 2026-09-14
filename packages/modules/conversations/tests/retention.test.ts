import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { receiveInbound } from '../application/conversations';
import {
  deleteR2Keys,
  purgeTenantRetention,
  retentionConsumers,
  retentionCutoff,
  scheduleRetentionNotice,
  setRetentionOverride,
  tenantsWithRetention,
} from '../application/retention';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;

async function conversacionVieja(
  phone: string,
  mesesAtras: number,
  state = 'resolved',
  archivada = false,
) {
  const res = await withTenant(admin, tenant, (c) =>
    receiveInbound(c, { tenantId: tenant, phone, channel: 'simulador', body: 'hola de hace tiempo' }),
  );
  await admin.query(
    `UPDATE conversations SET state = $2,
        archived_at = CASE WHEN $4 THEN now() ELSE NULL END,
        last_message_at = now() - make_interval(months => $3)
      WHERE id = $1`,
    [res.conversation.id, state, mesesAtras, archivada],
  );
  return res.conversation.id;
}

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query(
    "INSERT INTO tenants (name, plan, state) VALUES ('retention-test', 'base', 'active') RETURNING id",
  );
  tenant = t.rows[0].id;
});

afterAll(async () => {
  for (const tabla of ['messages', 'conversations', 'contacts', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.end();
});

describe('el corte (#77)', () => {
  it('plan base = 12 meses; el override solo ACORTA y se valida al guardar', async () => {
    const base = await withTenant(admin, tenant, (c) => retentionCutoff(c, tenant));
    expect(base.months).toBe(12);

    await expect(
      withTenant(admin, tenant, (c) => setRetentionOverride(c, { tenantId: tenant, months: 24 })),
    ).rejects.toThrow(/plan/); // más que el plan: no

    await withTenant(admin, tenant, (c) => setRetentionOverride(c, { tenantId: tenant, months: 6 }));
    const corto = await withTenant(admin, tenant, (c) => retentionCutoff(c, tenant));
    expect(corto.months).toBe(6);
    await withTenant(admin, tenant, (c) => setRetentionOverride(c, { tenantId: tenant, months: null }));
  });

  it('el padre del job solo mira tenants activos con retención finita', async () => {
    expect(await tenantsWithRetention(admin)).toContain(tenant);
  });
});

describe('la purga (#77)', () => {
  it('borra lo viejo resuelto; JAMÁS new/open/snoozed; audit UNA vez; R2 después', async () => {
    const vieja = await conversacionVieja('+56901010001', 14, 'resolved');
    const archivada = await conversacionVieja('+56901010002', 15, 'resolved', true);
    const abiertaVieja = await conversacionVieja('+56901010003', 20, 'open'); // intocable
    const reciente = await conversacionVieja('+56901010004', 2, 'resolved'); // dentro del plan
    // Un adjunto en la vieja: la llave debe salir ANTES del delete.
    await admin.query(
      `UPDATE messages SET attachments = '[{"key": "t/adjunto-viejo.jpg"}]'::jsonb
        WHERE tenant_id = $1 AND conversation_id = $2`,
      [tenant, vieja],
    );

    const res = await purgeTenantRetention(admin, tenant);
    expect(res).not.toBeNull();
    expect(res!.purged).toBe(2); // la resuelta y la archivada
    expect(res!.r2Keys).toContain('t/adjunto-viejo.jpg');

    const quedan = await admin.query(
      `SELECT id FROM conversations WHERE tenant_id = $1 ORDER BY created_at`,
      [tenant],
    );
    const ids = quedan.rows.map((r) => r.id);
    expect(ids).toContain(abiertaVieja);
    expect(ids).toContain(reciente);
    expect(ids).not.toContain(vieja);
    expect(ids).not.toContain(archivada);

    // Los mensajes se fueron con ellas; el contacto QUEDA.
    const msgs = await admin.query(
      `SELECT count(*)::int AS n FROM messages WHERE tenant_id = $1 AND conversation_id = $2`,
      [tenant, vieja],
    );
    expect(msgs.rows[0].n).toBe(0);
    const contactos = await admin.query(`SELECT count(*)::int AS n FROM contacts WHERE tenant_id = $1`, [tenant]);
    expect(contactos.rows[0].n).toBe(4);

    // UNA entrada de audit por corrida, con corte y cantidad.
    const audit = await admin.query(
      `SELECT metadata FROM audit_log WHERE tenant_id = $1 AND action = 'conversations.retention.purged'`,
      [tenant],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].metadata.purged).toBe(2);
    const evento = await admin.query(
      `SELECT count(*)::int AS n FROM outbox WHERE tenant_id = $1 AND name = 'conversations.retention.purged'`,
      [tenant],
    );
    expect(evento.rows[0].n).toBe(1);

    // Sin nada nuevo que purgar: la corrida siguiente es un no-op.
    expect(await purgeTenantRetention(admin, tenant)).toBeNull();
  });

  it('bajar de plan difiere la purga 30 días con la cantidad EXACTA', async () => {
    await conversacionVieja('+56901010005', 14, 'resolved');
    const client = await admin.connect();
    try {
      const consumer = retentionConsumers()[0];
      await consumer.handler(
        {
          id: 5001,
          name: 'tenant.plan_changed',
          tenantId: tenant,
          payload: { to: 'base' },
          actor: 'system',
          requestId: null,
          version: 1,
          occurredAt: new Date(),
        } as never,
        client,
      );
    } finally {
      client.release();
    }
    const evento = await admin.query(
      `SELECT payload FROM outbox WHERE tenant_id = $1 AND name = 'conversations.retention.scheduled'`,
      [tenant],
    );
    expect(evento.rows[0].payload.count).toBe(1); // la cantidad exacta

    // Con el aviso corriendo, la purga espera.
    const res = await purgeTenantRetention(admin, tenant);
    expect(res).toBeNull();
    const marca = await admin.query(
      `SELECT settings->'retencion'->>'firstPurgeAfter' AS fpa FROM tenants WHERE id = $1`,
      [tenant],
    );
    expect(marca.rows[0].fpa).not.toBeNull();

    // Cumplidos los 30 días: purga y LIMPIA la marca.
    await admin.query(
      `UPDATE tenants SET settings = jsonb_set(settings, '{retencion,firstPurgeAfter}',
         to_jsonb((now() - interval '1 hour')::text)) WHERE id = $1`,
      [tenant],
    );
    const purgada = await purgeTenantRetention(admin, tenant);
    expect(purgada!.purged).toBe(1);
    const limpia = await admin.query(
      `SELECT settings->'retencion' ? 'firstPurgeAfter' AS tiene FROM tenants WHERE id = $1`,
      [tenant],
    );
    expect(limpia.rows[0].tiene).toBe(false);
  });

  it('deleteR2Keys es idempotente: el 404 cuenta como borrado', async () => {
    const llamadas: string[] = [];
    const fetch404: typeof fetch = async (url) => {
      llamadas.push(String(url));
      return new Response('', { status: 404 });
    };
    const res = await deleteR2Keys(
      { endpoint: 'https://r2.local', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' } as never,
      ['a.jpg', 'b.jpg'],
      fetch404,
    );
    expect(res).toEqual({ deleted: 2, failed: 0 });
    expect(llamadas).toHaveLength(2);
  });

  it('scheduleRetentionNotice sin nada que capturar devuelve null y no marca', async () => {
    const aviso = await withTenant(admin, tenant, (c) => scheduleRetentionNotice(c, tenant));
    expect(aviso).toBeNull();
  });
});
