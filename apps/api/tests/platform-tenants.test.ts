import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { urlDeLaApp } from './url-de-la-app';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createInvitation, acceptInvitation } from '@iaxti/module-identity';
import { createApp } from '../src/main';
import { dbRoleResolver } from '../src/auth/role-resolver';

// La API de gestión de tenants (#68): solo SUPERADMIN opera; el tenant
// VE el aviso del modo soporte.
const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const ISSUER = 'https://test.supabase.local/auth/v1';

let app: INestApplication;
let base: string;
let admin: Pool;
let tenant: string;
let firmar: (sub: string) => Promise<string>;
const duena = randomUUID(); // ADMIN del tenant, NO superadmin
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
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query(
    "INSERT INTO tenants (name, plan, state) VALUES ('test-platform-api', 'base', 'active') RETURNING id",
  );
  tenant = t.rows[0].id;
  const inv = await withTenant(admin, tenant, (c) =>
    createInvitation(c, { tenantId: tenant, email: 'dueña@plat.cl', roleName: 'ADMIN' }),
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
  // El defecto de IA es del DESPLIEGUE, así que su tabla no tiene tenant y no
  // la limpia el `afterAll` de abajo. Sin esto, la prueba del rastro depende
  // de si otra corrida dejó una fila —y `veniaDelCodigo` da distinto—, que es
  // el patrón de #911: una prueba que solo pasa con la base virgen.
  await admin.query('DELETE FROM agent_task_defaults');
  app = await createApp({
    jwtVerify: async (token) => {
      const { payload } = await jwtVerify(token, jwks, { issuer: ISSUER });
      return { userId: payload.sub as string };
    },
    resolveRole: dbRoleResolver(admin),
    resolvePlatformAdmin: async (userId) => userId === superadmin,
  });
  await app.listen(0);
  base = urlDeLaApp(app);
});

afterAll(async () => {
  await app.close();
  for (const tabla of ['platform_support_sessions', 'user_roles', 'invitations', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  // Sin `tenant_id`: se limpia entera, y por eso también se limpia al entrar.
  await admin.query('DELETE FROM agent_task_defaults');
  await admin.end();
});

describe('/v1/platform/tenants (#68)', () => {
  it('el ADMIN de un tenant NO opera la plataforma; el SUPERADMIN sí', async () => {
    expect(
      (await pedir(duena, `/platform/tenants/${tenant}/support`, { method: 'POST', body: '{}' })).status,
    ).toBe(403);

    const detalle = await pedir(superadmin, `/platform/tenants/${tenant}`);
    expect(detalle.status).toBe(200);
    const d = await detalle.json();
    expect(d).toMatchObject({ plan: 'base', state: 'active' });
    expect(d.usage).toBeDefined();
  });

  it('modo soporte: el SUPERADMIN lo inicia y el TENANT lo ve; cerrar lo apaga', async () => {
    const inicio = await pedir(superadmin, `/platform/tenants/${tenant}/support`, {
      method: 'POST',
      body: JSON.stringify({ hours: 2, reason: 'ayuda con la bandeja' }),
    });
    expect(inicio.status).toBe(201);

    // El AVISO visible desde la cuenta del tenant (cualquier miembro).
    const aviso = await (await pedir(duena, '/support-status')).json();
    expect(aviso.active).toBe(true);

    await pedir(superadmin, `/platform/tenants/${tenant}/support`, { method: 'DELETE' });
    const apagado = await (await pedir(duena, '/support-status')).json();
    expect(apagado.active).toBe(false);
  });

  it('suspender/reactivar y cambiar plan, todo auditado superadmin', async () => {
    const sus = await pedir(superadmin, `/platform/tenants/${tenant}/state`, {
      method: 'POST',
      body: JSON.stringify({ action: 'suspend' }),
    });
    expect((await sus.json()).state).toBe('suspended');

    const react = await pedir(superadmin, `/platform/tenants/${tenant}/state`, {
      method: 'POST',
      body: JSON.stringify({ action: 'reactivate' }),
    });
    expect((await react.json()).state).toBe('active');

    const plan = await pedir(superadmin, `/platform/tenants/${tenant}/plan`, {
      method: 'POST',
      body: JSON.stringify({ plan: 'crece' }),
    });
    expect((await plan.json()).plan).toBe('crece');

    const audit = await admin.query(
      `SELECT count(*)::int AS n FROM audit_log
        WHERE tenant_id = $1 AND actor_kind = 'superadmin'`,
      [tenant],
    );
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(5);
  });
});

/**
 * El defecto de IA de la plataforma, por HTTP (#858).
 *
 * Lo que estas pruebas cuidan es la puerta: el caso de uso tiene las suyas en
 * `module-agents`, pero el actor real y el rastro solo entran por acá.
 */
describe('/v1/platform/ia/defectos (#858)', () => {
  it('el ADMIN de un tenant no lo ve ni lo cambia; el SUPERADMIN sí', async () => {
    expect((await pedir(duena, '/platform/ia/defectos')).status).toBe(403);
    const r = await pedir(superadmin, '/platform/ia/defectos');
    expect(r.status).toBe(200);
    const cuerpo = await r.json();
    // Las nueve tareas, aunque nadie haya cambiado ninguna: una tarea sin fila
    // no es un hueco, es «nadie la tocó».
    expect(Object.keys(cuerpo.tareas).length).toBeGreaterThanOrEqual(9);
    expect(cuerpo.tareas.sugerir.desdeLaBase).toBe(false);
    // Y el panel recibe qué puede ofrecer, en vez de dejar elegir y que el
    // servidor rechace después.
    expect(cuerpo.proveedoresPermitidos).toContain('openai');
    expect(cuerpo.proveedoresPermitidos).not.toContain('anthropic');
  });

  it('cambiarlo lo guarda y deja el rastro en platform_audit', async () => {
    const r = await pedir(superadmin, '/platform/ia/defectos/resumir', {
      method: 'PUT',
      body: JSON.stringify({ provider: 'openai', model: 'gpt-5', esfuerzo: 'medio' }),
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ provider: 'openai', model: 'gpt-5', desdeLaBase: true });

    const rastro = await admin.query(
      `SELECT admin_user, metadata FROM platform_audit
        WHERE action = 'ia.defecto_cambiado' ORDER BY id DESC LIMIT 1`,
    );
    expect(rastro.rows[0].admin_user).toBe(superadmin);
    // De qué a qué: un registro que solo dice el valor nuevo no permite
    // reconstruir por qué el producto se comportó como se comportó.
    expect(rastro.rows[0].metadata).toMatchObject({
      tarea: 'resumir',
      despues: { provider: 'openai', model: 'gpt-5', esfuerzo: 'medio' },
      veniaDelCodigo: true,
    });
  });

  it('un proveedor sin fila de compliance se rechaza con su código', async () => {
    const r = await pedir(superadmin, '/platform/ia/defectos/conocer', {
      method: 'PUT',
      body: JSON.stringify({ provider: 'anthropic', model: 'claude-x' }),
    });
    // 400 y no 500: es una decisión de datos mal pedida, no una falla.
    expect(r.status).toBe(400);
    const { code } = await r.json();
    // El cuerpo lo rechaza el esquema antes de llegar al caso de uso, y eso
    // está bien: las dos puertas dicen lo mismo.
    expect(['VALIDATION_ERROR', 'PROVEEDOR_SIN_COMPLIANCE']).toContain(code);
  });

  it('un campo de más se rechaza: recibirlo y descartarlo hace creer que entró', async () => {
    const r = await pedir(superadmin, '/platform/ia/defectos/conocer', {
      method: 'PUT',
      body: JSON.stringify({ provider: 'openai', model: 'gpt-5-mini', tenantId: 'algo' }),
    });
    expect(r.status).toBe(400);
  });
});

