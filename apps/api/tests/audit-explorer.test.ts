import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createInvitation, acceptInvitation } from '@iaxti/module-identity';
import { verifyExport, writeAudit } from '@iaxti/module-audit';
import { createApp } from '../src/main';
import { dbRoleResolver } from '../src/auth/role-resolver';

// El explorador de auditoría por la API (#72): quién puede mirar qué libro,
// la verificación de la cadena y la exportación firmada de punta a punta.
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const ISSUER = 'https://test.supabase.local/auth/v1';
const SECRETO = 'secreto-de-auditor';

let app: INestApplication;
let base: string;
let admin: Pool;
let tenant: string;
let firmar: (sub: string) => Promise<string>;
const duena = randomUUID(); // ADMIN: tiene audit.read
const vendedor = randomUUID(); // USER: no lo tiene
const superadmin = randomUUID();

async function pedir(quien: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${await firmar(quien)}`,
      'X-Tenant-Id': tenant,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? ADMIN_URL;
  process.env.AUDIT_EXPORT_SECRET = SECRETO;
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query(
    "INSERT INTO tenants (name, plan, state) VALUES ('test-audit-api', 'base', 'active') RETURNING id",
  );
  tenant = t.rows[0].id;
  for (const [userId, email, roleName] of [
    [duena, 'duena@audit.cl', 'ADMIN'],
    [vendedor, 'vende@audit.cl', 'USER'],
  ] as const) {
    const inv = await withTenant(admin, tenant, (c) =>
      createInvitation(c, { tenantId: tenant, email, roleName }),
    );
    await withTenant(admin, tenant, (c) => acceptInvitation(c, { token: inv.token, userId }));
  }
  await withTenant(admin, tenant, (c) =>
    writeAudit(c, {
      tenantId: tenant,
      actor: duena,
      actorKind: 'user',
      action: 'prueba.exploracion',
      resource: 'demo',
      resourceId: 'x-1',
      result: 'ok',
      ip: '190.44.1.2',
    }),
  );

  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg: 'ES256' }] });
  firmar = (sub) =>
    new SignJWT({})
      .setProtectedHeader({ alg: 'ES256' })
      .setSubject(sub)
      .setIssuer(ISSUER)
      .setExpirationTime('5m')
      .sign(privateKey);
  app = await createApp({
    jwtVerify: async (token) => {
      const { payload } = await jwtVerify(token, jwks, { issuer: ISSUER });
      return { userId: payload.sub as string };
    },
    resolveRole: dbRoleResolver(admin),
    resolvePlatformAdmin: async (userId) => userId === superadmin,
  });
  await app.listen(0);
  base = await app.getUrl();
});

afterAll(async () => {
  await app.close();
  await admin.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update_delete');
  await admin.query('DELETE FROM audit_log WHERE tenant_id = $1', [tenant]);
  await admin.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update_delete');
  for (const tabla of ['user_roles', 'invitations', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.end();
});

describe('/v1/audit (#72)', () => {
  it('el ADMIN filtra su libro; el USER ni lo abre', async () => {
    expect((await pedir(vendedor, '/audit')).status).toBe(403);

    const res = await pedir(duena, '/audit?action=prueba.exploracion&actorKind=user&ip=190.44.1.2');
    expect(res.status).toBe(200);
    const filas = await res.json();
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ action: 'prueba.exploracion', result: 'ok', ip: '190.44.1.2' });

    expect(await (await pedir(duena, '/audit?action=no.existe')).json()).toHaveLength(0);
  });

  it('una fecha que no se entiende se rechaza, no se ignora', async () => {
    const res = await pedir(duena, '/audit?from=ayer');
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('FILTER_INVALID');
  });

  it('la cadena se verifica desde la API, y el global exige el tenant', async () => {
    const propia = await (
      await pedir(duena, '/audit/verify', { method: 'POST', body: '{}' })
    ).json();
    expect(propia.valid).toBe(true);
    expect(propia.entries).toBeGreaterThanOrEqual(1);

    const global = await (
      await pedir(superadmin, `/platform/audit/verify?tenantId=${tenant}`, {
        method: 'POST',
        body: '{}',
      })
    ).json();
    expect(global.valid).toBe(true);

    const sinTenant = await pedir(superadmin, '/platform/audit/verify', {
      method: 'POST',
      body: '{}',
    });
    expect(sinTenant.status).toBe(400);
  });

  it('el export sale firmado y la verificación de referencia calza', async () => {
    const doc = await (await pedir(duena, '/audit/export?format=csv')).json();
    expect(doc.signature).not.toBeNull();
    expect(doc.payload).toContain('prueba.exploracion');
    expect(verifyExport(doc, SECRETO)).toBe(true);
    // Si alguien edita el CSV exportado, la firma deja de calzar.
    expect(verifyExport({ ...doc, payload: doc.payload + 'x' }, SECRETO)).toBe(false);

    const malFormato = await pedir(duena, '/audit/export?format=pdf');
    expect(malFormato.status).toBe(400);
  });

  it('el libro global es del SUPERADMIN, y trae el tenant en cada fila', async () => {
    expect((await pedir(duena, '/platform/audit')).status).toBe(403);

    const filas = await (
      await pedir(superadmin, `/platform/audit?tenantId=${tenant}&action=prueba.exploracion`)
    ).json();
    expect(filas).toHaveLength(1);
    expect(filas[0].tenant_id).toBe(tenant);

    const json = await (
      await pedir(superadmin, `/platform/audit/export?format=json&tenantId=${tenant}`)
    ).json();
    expect(JSON.parse(json.payload).length).toBeGreaterThanOrEqual(1);
    expect(verifyExport(json, SECRETO)).toBe(true);
  });
});
