import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { acceptInvitation, createInvitation } from '@iaxti/module-identity';
import { createApp } from '../src/main';
import { dbRoleResolver } from '../src/auth/role-resolver';

// El equipo del negocio: invitar, ver quién está y quitar acceso. Las
// funciones existían desde la Fase 1 y ninguna ruta las exponía — no se
// podía agregar la segunda persona a un CRM multiusuario.

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const ISSUER = 'https://test.supabase.local/auth/v1';

let app: INestApplication;
let base: string;
let admin: Pool;
let tenant: string;
let firmar: (sub: string) => Promise<string>;
const duena = randomUUID();
const vendedor = randomUUID();
const otroAdmin = randomUUID();

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
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('equipo-test') RETURNING id");
  tenant = t.rows[0].id;
  for (const [userId, email, roleName] of [
    [duena, 'duena@equipo.cl', 'ADMIN'],
    [vendedor, 'vende@equipo.cl', 'USER'],
  ] as const) {
    const inv = await withTenant(admin, tenant, (c) =>
      createInvitation(c, { tenantId: tenant, email, roleName }),
    );
    await withTenant(admin, tenant, (c) => acceptInvitation(c, { token: inv.token, userId }));
  }

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
    resolvePlatformAdmin: async () => false,
  });
  await app.listen(0);
  base = await app.getUrl();
});

afterAll(async () => {
  await app.close();
  for (const tabla of ['user_roles', 'invitations', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.end();
});

describe('/v1/equipo', () => {
  it('muestra quién tiene acceso, con su rol y su correo', async () => {
    const res = await pedir(duena, '/equipo');
    expect(res.status).toBe(200);
    const { miembros } = await res.json();
    expect(miembros).toHaveLength(2);
    const dueña = miembros.find((m: { userId: string }) => m.userId === duena);
    expect(dueña).toMatchObject({ rol: 'ADMIN', email: 'duena@equipo.cl' });
  });

  it('el USER no invita ni mira el equipo', async () => {
    expect((await pedir(vendedor, '/equipo')).status).toBe(403);
    expect(
      (await pedir(vendedor, '/equipo/invitaciones', {
        method: 'POST',
        body: JSON.stringify({ email: 'nuevo@equipo.cl', rol: 'USER' }),
      })).status,
    ).toBe(403);
  });

  it('invitar valida el correo y el rol antes de crear nada', async () => {
    const malCorreo = await pedir(duena, '/equipo/invitaciones', {
      method: 'POST',
      body: JSON.stringify({ email: 'no-es-un-correo', rol: 'USER' }),
    });
    expect(malCorreo.status).toBe(400);

    // Un rol inventado crearía a alguien que entra y no puede hacer nada.
    const malRol = await pedir(duena, '/equipo/invitaciones', {
      method: 'POST',
      body: JSON.stringify({ email: 'nuevo@equipo.cl', rol: 'JEFAZO' }),
    });
    expect(malRol.status).toBe(400);
    expect((await malRol.json()).code).toBe('ROLE_UNKNOWN');
  });

  it('invita, aparece como pendiente y no se puede invitar dos veces', async () => {
    const res = await pedir(duena, '/equipo/invitaciones', {
      method: 'POST',
      body: JSON.stringify({ email: 'Nuevo@Equipo.cl', rol: 'USER' }),
    });
    expect(res.status).toBe(201);
    const inv = await res.json();
    // El correo se normaliza: dos mayúsculas distintas no son dos personas.
    expect(inv.email).toBe('nuevo@equipo.cl');
    // El enlace viaja UNA vez, para poder pasarlo a mano sin SMTP.
    expect(inv.enlace).toContain('/invitacion/');

    const pendientes = await (await pedir(duena, '/equipo')).json();
    expect(pendientes.invitaciones.some((i: { email: string }) => i.email === 'nuevo@equipo.cl')).toBe(true);

    const repetida = await pedir(duena, '/equipo/invitaciones', {
      method: 'POST',
      body: JSON.stringify({ email: 'nuevo@equipo.cl', rol: 'USER' }),
    });
    expect(repetida.status).toBe(400);
    expect((await repetida.json()).code).toBe('INVITATION_PENDING');

    // Y se puede cancelar.
    const cancelada = await pedir(duena, `/equipo/invitaciones/${inv.id}`, { method: 'DELETE' });
    expect(cancelada.status).toBe(200);
  });

  it('nadie se quita a sí mismo, ni deja al negocio sin quien lo administre', async () => {
    const solo = await pedir(duena, `/equipo/miembros/${duena}`, { method: 'DELETE' });
    expect(solo.status).toBe(400);
    expect((await solo.json()).message).toMatch(/a ti mismo/);

    // Con dos ADMIN sí se puede quitar a uno.
    const inv = await withTenant(admin, tenant, (c) =>
      createInvitation(c, { tenantId: tenant, email: 'otro@equipo.cl', roleName: 'ADMIN' }),
    );
    await withTenant(admin, tenant, (c) => acceptInvitation(c, { token: inv.token, userId: otroAdmin }));
    const quitado = await pedir(duena, `/equipo/miembros/${otroAdmin}`, { method: 'DELETE' });
    expect(quitado.status).toBe(200);

    // Y quitar al vendedor deja al ADMIN solo: el siguiente intento de
    // quitarlo a él tiene que fallar.
    expect((await pedir(duena, `/equipo/miembros/${vendedor}`, { method: 'DELETE' })).status).toBe(200);
    const sinAdmin = await pedir(duena, `/equipo/miembros/${duena}`, { method: 'DELETE' });
    expect(sinAdmin.status).toBe(400);
  });
});
