import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createInvitation, acceptInvitation } from '@iaxti/module-identity';
import { createApp } from '../src/main';
import { dbRoleResolver } from '../src/auth/role-resolver';

/**
 * El cableado del actor en `/v1/campos` (#534).
 *
 * El módulo recibe el actor como parámetro OPCIONAL —tiene que ser opcional:
 * lo llaman el seed y la consola—, así que el controlador es el único lugar
 * donde entra una persona de verdad. Si no lo pasa, no falla nada: el libro
 * dice «system» y nadie se entera hasta que alguien pregunta quién marcó
 * «Nota interna» como visible para la IA.
 *
 * Las pruebas del módulo (`packages/modules/crm/tests/campos.test.ts`) le
 * pasan el actor a mano, así que pasarían igual con el controlador
 * desconectado. Esto corre el camino completo: HTTP → guard → caso de uso →
 * `audit_log`, por las dos identidades que pueden escribir acá, sesión y API
 * key, porque son dos ramas distintas del controlador.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const ISSUER = 'https://test.supabase.local/auth/v1';
const LLAVE_QUE_CONFIGURA = 'test-campos-manage-key';
const LLAVE_QUE_SOLO_LEE = 'test-campos-read-key';

let app: INestApplication;
let base: string;
let admin: Pool;
let tenant: string;
let firmar: (sub: string) => Promise<string>;
const duena = randomUUID();
const vendedora = randomUUID();

/** Una llamada con sesión de persona. */
async function conSesion(
  path: string,
  init: RequestInit & { como?: string; requestId?: string } = {},
): Promise<Response> {
  const { como, requestId, ...resto } = init;
  return fetch(`${base}/v1${path}`, {
    ...resto,
    headers: {
      Authorization: `Bearer ${await firmar(como ?? duena)}`,
      'X-Tenant-Id': tenant,
      'Content-Type': 'application/json',
      ...(requestId ? { 'X-Request-Id': requestId } : {}),
      ...(resto.headers ?? {}),
    },
  });
}

/** La misma llamada, pero la hace una API key. */
async function conLlave(path: string, init: RequestInit & { llave?: string } = {}): Promise<Response> {
  const { llave, ...resto } = init;
  return fetch(`${base}/v1${path}`, {
    ...resto,
    headers: {
      'X-Api-Key': llave ?? LLAVE_QUE_CONFIGURA,
      'Content-Type': 'application/json',
      ...(resto.headers ?? {}),
    },
  });
}

const rastroDe = async (campoId: string, accion: string) =>
  admin.query(
    `SELECT actor, actor_kind, action, request_id, metadata FROM audit_log
      WHERE tenant_id = $1 AND resource_id = $2 AND action = $3`,
    [tenant, campoId, accion],
  );

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? ADMIN_URL;
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  tenant = (await admin.query("INSERT INTO tenants (name) VALUES ('campos-actor') RETURNING id"))
    .rows[0].id;

  // La dueña configura (ADMIN tiene `crm.fields.manage`); la vendedora no: es
  // la que comprueba que la ruta nueva también pasa por el guard.
  for (const [userId, rol, correo] of [
    [duena, 'ADMIN', 'duena@campos.cl'],
    [vendedora, 'USER', 'vende@campos.cl'],
  ] as const) {
    const inv = await withTenant(admin, tenant, (c) =>
      createInvitation(c, { tenantId: tenant, email: correo, roleName: rol }),
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
    resolveApiKey: async (token) =>
      token === LLAVE_QUE_CONFIGURA
        ? { id: 'llave-campos', tenantId: tenant, scopes: ['crm.fields.manage'] }
        : token === LLAVE_QUE_SOLO_LEE
          ? { id: 'llave-lectura', tenantId: tenant, scopes: ['crm.contacts.read'] }
          : null,
  });
  await app.listen(0);
  base = await app.getUrl();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('quién declaró, cambió y borró el campo, por el puerto de verdad (#534)', () => {
  let campo: { id: string; key: string };

  it('declarar por sesión escribe a la PERSONA, no a «system»', async () => {
    const requestId = `req-${randomUUID()}`;
    const res = await conSesion('/campos', {
      method: 'POST',
      requestId,
      body: JSON.stringify({ entity: 'contact', label: 'Nota interna', type: 'texto', visibleIa: false }),
    });
    expect(res.status).toBe(201);
    campo = await res.json();

    const r = await rastroDe(campo.id, 'fields.create');
    expect(r.rowCount).toBe(1);
    // El id de la sesión, que es lo único que no puede inventar el módulo.
    expect(r.rows[0].actor).toBe(duena);
    expect(r.rows[0].actor_kind).toBe('user');
    expect(r.rows[0].request_id).toBe(requestId);
    expect(r.rows[0].metadata).toMatchObject({ key: 'nota_interna', visibleIa: false });
  });

  it('editar por API key queda a nombre de la llave, no de una persona', async () => {
    // La rama `apikey` del controlador: `actor` pasa a ser `apikey:<id>` y el
    // tipo deja de ser 'user'. Un integrador que marca un campo como visible
    // para la IA tiene que distinguirse de alguien del equipo haciéndolo.
    const res = await conLlave(`/campos/${campo.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ visibleIa: true, label: 'Nota del equipo' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ key: 'nota_interna', label: 'Nota del equipo', visibleIa: true });

    const r = await rastroDe(campo.id, 'fields.update');
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].actor).toBe('apikey:llave-campos');
    expect(r.rows[0].actor_kind).toBe('apikey');
    expect(r.rows[0].metadata).toMatchObject({
      key: 'nota_interna',
      antes: { label: 'Nota interna', visibleIa: false },
      despues: { label: 'Nota del equipo', visibleIa: true },
    });
  });

  it('lo que no se puede cambiar se rechaza, no se ignora', async () => {
    // Un 200 que no cambió el tipo haría creer al integrador que lo cambió.
    const res = await conLlave(`/campos/${campo.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ type: 'numero' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'VALIDATION_ERROR', requestId: expect.any(String) });
    expect((await rastroDe(campo.id, 'fields.update')).rowCount).toBe(1);
  });

  it('sin el permiso no se edita, y el intento no deja un rastro que mienta', async () => {
    // Endpoint nuevo, prueba del guard (`.claude/rules/testing.md`): la
    // vendedora no tiene `crm.fields.manage` y la llave de lectura tampoco.
    for (const res of [
      await conSesion(`/campos/${campo.id}`, {
        method: 'PATCH',
        como: vendedora,
        body: JSON.stringify({ visibleIa: false }),
      }),
      await conLlave(`/campos/${campo.id}`, {
        method: 'PATCH',
        llave: LLAVE_QUE_SOLO_LEE,
        body: JSON.stringify({ visibleIa: false }),
      }),
    ]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ requestId: expect.any(String), details: [] });
    }
    expect((await rastroDe(campo.id, 'fields.update')).rowCount).toBe(1);
  });

  it('borrar por API key también dice quién fue', async () => {
    expect((await conLlave(`/campos/${campo.id}`, { method: 'DELETE' })).status).toBe(200);
    const r = await rastroDe(campo.id, 'fields.delete');
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].actor).toBe('apikey:llave-campos');
    expect(r.rows[0].actor_kind).toBe('apikey');
    // La definición sobrevive al borrado en el libro, que es el punto.
    expect(r.rows[0].metadata).toMatchObject({ key: 'nota_interna', label: 'Nota del equipo', fichasConValor: 0 });
  });
});
