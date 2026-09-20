import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createPaymentLink, listLinks } from '@iaxti/module-payments';
import { processPaymentWebhook } from '../src/payments';

let pool: Pool;
let tenantId: string;
let providerId: string;
beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  tenantId = (await pool.query("INSERT INTO tenants (name) VALUES ('flow-config-366') RETURNING id")).rows[0].id;
  providerId = (await pool.query(`INSERT INTO payment_providers (tenant_id, kind, name, credential_ref, mode)
    VALUES ($1, 'flow', 'Flow por configurar', 'FLOW_CRED_366_TEST', 'test') RETURNING id`, [tenantId])).rows[0].id;
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  await pool.query('DELETE FROM payment_providers WHERE tenant_id = $1', [tenantId]);
  await pool.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
  await pool.end();
});
const job = () => ({
  moduleId: 'payments' as const, tenantId, providerId, providerKind: 'flow',
  pago: { linkId: '', status: 'pending' as const, providerPaymentId: 'token-local', method: null, receiptUrl: null, amountClp: null },
});
const crear = () => withTenant(pool, tenantId, (client) => createPaymentLink(client, {
  tenantId, providerId, contactId: null, amountClp: 1000, concept: 'Local', actorUserId: null,
}));

describe('configuración Flow aplicada al caso de uso y al worker', () => {
  it('un registro test con URL live rechaza creación y confirmación antes de la red', async () => {
    vi.stubEnv('IAXTI_ENV', 'staging');
    vi.stubEnv('FLOW_API_BASE', 'https://www.flow.cl/api');
    vi.stubEnv('FLOW_CRED_366_TEST', 'synthetic-key-366:synthetic-secret-366');
    const fetcher = vi.fn<typeof fetch>();
    await expect(crear()).rejects.toThrow(/destino oficial/);
    await expect(processPaymentWebhook(pool, job(), fetcher)).rejects.toThrow(/destino oficial/);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await withTenant(pool, tenantId, (c) => listLinks(c, tenantId))).toEqual([]);
    const effects = await pool.query(`SELECT
      (SELECT count(*)::int FROM audit_log WHERE tenant_id = $1) AS audit,
      (SELECT count(*)::int FROM outbox WHERE tenant_id = $1) AS events`, [tenantId]);
    expect(effects.rows[0]).toEqual({ audit: 0, events: 0 });
  });

  it('credenciales vacías o de ejemplo dejan el cobro sin habilitar y no crean links', async () => {
    vi.stubEnv('FLOW_API_BASE', 'https://sandbox.flow.cl/api');
    for (const cred of ['', 'apiKey:secretKey']) {
      vi.stubEnv('FLOW_CRED_366_TEST', cred);
      await expect(crear()).rejects.toThrow(/Falta|credenciales/);
    }
    expect(await withTenant(pool, tenantId, (c) => listLinks(c, tenantId))).toEqual([]);
  });

  it('la consulta de estado usa el modo persistido y rechaza redirecciones', async () => {
    vi.stubEnv('IAXTI_ENV', 'staging');
    vi.stubEnv('FLOW_API_BASE', 'https://sandbox.flow.cl/api');
    vi.stubEnv('FLOW_CRED_366_TEST', 'synthetic-key-366:synthetic-secret-366');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ commerceOrder: 'local', status: 1 }));
    expect(await processPaymentWebhook(pool, job(), fetcher)).toEqual({ outcome: 'pendiente' });
    expect(fetcher).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/sandbox\.flow\.cl\/api\/payment\/getStatus\?/), { redirect: 'error' });
    const url = new URL(fetcher.mock.calls[0][0] as string);
    expect(url.searchParams.get('s')).toMatch(/^[a-f0-9]{64}$/);
    expect(url.searchParams.has('secretKey')).toBe(false);
  });
});
