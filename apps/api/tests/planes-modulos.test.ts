import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createInvitation, acceptInvitation } from '@iaxti/module-identity';
import {
  accesoAlModulo,
  modulosDelPlan,
  modulosVendibles,
  olvidarPlanes,
} from '@iaxti/module-organizations';
import { createApp } from '../src/main';
import { dbRoleResolver } from '../src/auth/role-resolver';

// El plan se cobra (SPEC §6, issue 209): `plan_limits.modules` existía y solo
// alimentaba un informe del SuperAdmin. El portón de la API preguntaba
// `registry.isActive()`, que es un flag GLOBAL del despliegue, mientras el
// mensaje de error hablaba de "tu plan". Un tenant del plan más barato usaba
// automatizaciones, conocimiento, integraciones y analítica.

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const ISSUER = 'https://test.supabase.local/auth/v1';

let app: INestApplication;
let base: string;
let admin: Pool;
let tenant: string;
let firmar: (sub: string) => Promise<string>;
const duena = randomUUID();

const REGLA = {
  name: 'Saludo',
  trigger: { kind: 'event', event: 'conversation.created' },
  conditions: [],
  actions: [{ kind: 'add_note', params: { body: 'hola' } }],
};

async function pedir(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${await firmar(duena)}`,
      'X-Tenant-Id': tenant,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? ADMIN_URL;
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query(
    "INSERT INTO tenants (name, plan) VALUES ('test-planes', 'base') RETURNING id",
  );
  tenant = t.rows[0].id;
  const inv = await withTenant(admin, tenant, (c) =>
    createInvitation(c, { tenantId: tenant, email: 'duena@planes.cl', roleName: 'ADMIN' }),
  );
  await withTenant(admin, tenant, (c) => acceptInvitation(c, { token: inv.token, userId: duena }));

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
    resolveAccesoModulo: async (tenantId, moduleId) => {
      const [vendibles, delPlan] = await Promise.all([
        modulosVendibles(admin),
        modulosDelPlan(admin, tenantId),
      ]);
      return accesoAlModulo({ moduleId, vendibles, delPlan: delPlan.modulos });
    },
  });
  await app.listen(0);
  base = await app.getUrl();
});

afterAll(async () => {
  await app.close();
  olvidarPlanes();
  for (const tabla of ['automation_rules', 'user_roles', 'invitations', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]).catch(() => {});
  }
  await admin.end();
});

describe('el plan decide el módulo (SPEC §6)', () => {
  it('plan base: puede LEER automatizaciones pero no crear ninguna', async () => {
    // Leer nunca se corta: bajar de plan no borra ni esconde.
    const leer = await pedir('/automations');
    expect(leer.status).toBe(200);

    const crear = await pedir('/automations', { method: 'POST', body: JSON.stringify(REGLA) });
    expect(crear.status).toBe(403);
    expect((await crear.json()).code).toBe('MODULE_NOT_IN_PLAN');
  });

  it('el mismo tenant en plan crece sí puede', async () => {
    await admin.query("UPDATE tenants SET plan = 'crece' WHERE id = $1", [tenant]);
    olvidarPlanes(); // el cambio de verdad pasa por changePlan(), que ya la olvida

    const crear = await pedir('/automations', { method: 'POST', body: JSON.stringify(REGLA) });
    expect(crear.status).toBeLessThan(300);
  });

  it('la infraestructura no depende del plan; lo vendible sí', async () => {
    const vendibles = await modulosVendibles(admin);
    expect(vendibles).not.toContain('identity');
    expect(vendibles).not.toContain('platform');
    expect(accesoAlModulo({ moduleId: 'platform', vendibles, delPlan: [] })).toBe('completo');
    expect(accesoAlModulo({ moduleId: 'analytics', vendibles, delPlan: ['crm'] })).toBe('solo_lectura');
  });

  it('el menú puede saber qué tiene candado antes de que alguien escriba nada', async () => {
    await admin.query("UPDATE tenants SET plan = 'base' WHERE id = $1", [tenant]);
    olvidarPlanes();

    const r = await pedir('/me/modules/plan');
    expect(r.status).toBe(200);
    const modulos = (await r.json()) as Array<{ id: string; acceso: string }>;
    const porId = Object.fromEntries(modulos.map((m) => [m.id, m.acceso]));

    expect(porId.automations).toBe('solo_lectura');
    expect(porId.crm).toBe('completo');
    // La infraestructura no depende del plan.
    expect(porId.identity ?? 'completo').toBe('completo');
  });

  it('sin sesión, el menú del servidor sigue saliendo como siempre', async () => {
    const r = await fetch(`${base}/v1/me/modules`);
    expect(r.status).toBe(200);
    const modulos = (await r.json()) as Array<{ id: string }>;
    expect(modulos.length).toBeGreaterThan(3);
  });
});
