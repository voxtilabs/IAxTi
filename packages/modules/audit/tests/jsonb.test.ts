import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { writeAudit, verifyChain } from '../src/write';

let pool: Pool;
let tenantId: string;
const base = { actor: 'system', actorKind: 'system' as const, action: 'prueba', resource: 'test', result: 'success' };
const en = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(pool, tenantId, fn);
beforeAll(async () => { pool = createPool(); await runMigrations(pool); });
beforeEach(async () => { tenantId = (await pool.query("INSERT INTO tenants (name) VALUES ('audit-jsonb') RETURNING id")).rows[0].id; });
afterAll(async () => { await pool.end(); });

describe('hash de la representación persistida (#375)', () => {
  it.each([
    { zeta: 1, a: 2, largo: 3 },
    { objeto: { z: 1, a: 2 }, lista: [{ zz: true, a: false }, 'último'] },
    { fecha: new Date('2026-09-20T12:34:56.789Z'), ausente: undefined, nulo: null, numero: 1e21 },
  ])('verifica después del round trip de jsonb: %j', async metadata => {
    await en(c => writeAudit(c, { ...base, tenantId, metadata }));
    // La verificación se hace en otra transacción/conexión, sobre lo leído.
    expect(await en(c => verifyChain(c, tenantId))).toEqual({ valid: true, entries: 1 });
    const fila = await pool.query('SELECT metadata FROM audit_log WHERE tenant_id = $1', [tenantId]);
    expect(fila.rows[0].metadata).toEqual(JSON.parse(JSON.stringify(metadata)));
  });
  it('encadena escrituras simultáneas con metadatos distintos', async () => {
    await Promise.all(Array.from({ length: 6 }, (_, i) => en(c => writeAudit(c, {
      ...base, tenantId, metadata: { indice: i, a: { zz: i, b: true } },
    }))));
    expect(await en(c => verifyChain(c, tenantId))).toEqual({ valid: true, entries: 6 });
  });
  it.each([
    { metadata: { a: 1 }, valid: true },
    { metadata: { zz: 1, a: 2 }, valid: false },
  ])('conserva el hash previo y su diagnóstico (válido=$valid)', async ({ metadata, valid }) => {
    // Fixture del formato anterior (main 01e13c6), sin normalización previa.
    const at = '2026-09-20T12:00:00.000Z';
    const hash = createHash('sha256').update(JSON.stringify({
      prev: null, t: tenantId, a: 'system', k: 'system', ac: 'legacy',
      r: 'test', ri: null, at, res: 'success', rq: null, m: metadata,
    })).digest('hex');
    await pool.query(`INSERT INTO audit_log
      (tenant_id, actor, actor_kind, action, resource, occurred_at, result, metadata, hash)
      VALUES ($1, 'system', 'system', 'legacy', 'test', $2, 'success', $4, $3)`, [tenantId, at, hash, JSON.stringify(metadata)]);
    await en(c => writeAudit(c, { ...base, tenantId, metadata: { z: 1, a: 2 } }));
    expect(await en(c => verifyChain(c, tenantId))).toMatchObject({ valid, entries: 2 });
    expect((await pool.query('SELECT hash FROM audit_log WHERE tenant_id = $1 ORDER BY id LIMIT 1', [tenantId])).rows[0].hash).toBe(hash);
  });
  it('alterar un valor de metadata sigue rompiendo la cadena', async () => {
    await en(c => writeAudit(c, { ...base, tenantId, metadata: { z: 1, a: 2 } }));
    await pool.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update_delete');
    try {
      await pool.query("UPDATE audit_log SET metadata = jsonb_set(metadata, '{z}', '999') WHERE tenant_id = $1", [tenantId]);
    } finally { await pool.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update_delete'); }
    expect((await en(c => verifyChain(c, tenantId))).valid).toBe(false);
  });
});
