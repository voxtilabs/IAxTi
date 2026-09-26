import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createInvitation, acceptInvitation } from '@iaxti/module-identity';
import { customRolePermissions } from '@iaxti/module-authorization';
import { createApp } from '../src/main';
import { dbCustomPermissionsResolver, dbRoleResolver } from '../src/auth/role-resolver';

// Roles personalizados (#73): clonar, editar, asignar — y el guard
// respetando el rol custom DE VERDAD en la request siguiente.
const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const ISSUER = 'https://test.supabase.local/auth/v1';

let app: INestApplication;
let base: string;
let admin: Pool;
let tenant: string;
let firmar: (sub: string) => Promise<string>;
const duena = randomUUID(); // ADMIN
const recepcionista = randomUUID(); // USER que pasará a rol custom

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
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('test-roles-custom') RETURNING id");
  tenant = t.rows[0].id;
  for (const [userId, email, roleName] of [
    [duena, 'dueña@roles.cl', 'ADMIN'],
    [recepcionista, 'rece@roles.cl', 'USER'],
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
  // SIN cache en los resolvers del test: el cambio de rol se nota al tiro.
  app = await createApp({
    jwtVerify: async (token) => {
      const { payload } = await jwtVerify(token, jwks, { issuer: ISSUER });
      return { userId: payload.sub as string };
    },
    resolveRole: (tenantId, userId) =>
      withTenant(admin, tenantId, async (c) => {
        const r = await c.query(
          `SELECT ro.name FROM user_roles ur JOIN roles ro ON ro.id = ur.role_id
            WHERE ur.tenant_id = $1 AND ur.user_id = $2`,
          [tenantId, userId],
        );
        return (r.rows[0]?.name as string) ?? null;
      }),
    // Sin cache, y ahora de verdad: `CreateAppOptions` no declaraba esta
    // opción, así que la app se quedaba con el resolver de la base —que
    // cachea 60 s— y este test comprobaba un cambio de permisos contra una
    // respuesta vieja. Pasaba según qué lectura hubiera calentado la cache.
    resolveCustomPermissions: (tenantId: string, roleName: string) =>
      withTenant(admin, tenantId, (c) => customRolePermissions(c, tenantId, roleName)),
  });
  void dbRoleResolver;
  void dbCustomPermissionsResolver;
  await app.listen(0);
  base = await app.getUrl();
});

afterAll(async () => {
  await app.close();
  await admin.query(`DELETE FROM user_roles WHERE tenant_id = $1`, [tenant]);
  await admin.query(`DELETE FROM roles WHERE tenant_id = $1`, [tenant]);
  await admin.query(`DELETE FROM invitations WHERE tenant_id = $1`, [tenant]);
  await admin.query(`DELETE FROM outbox WHERE tenant_id = $1`, [tenant]);
  await admin.end();
});

describe('/v1/roles (#73)', () => {
  it('lista base + catálogo con módulo y estado; gestionar es del ADMIN', async () => {
    expect(
      (await pedir(recepcionista, '/roles', { method: 'POST', body: JSON.stringify({ name: 'X', cloneFrom: 'USER' }) })).status,
    ).toBe(403);

    const roles = await (await pedir(duena, '/roles')).json();
    expect(roles.map((r: { name: string }) => r.name)).toEqual(
      expect.arrayContaining(['ADMIN', 'SUPERVISOR', 'USER']),
    );
    expect(roles.find((r: { name: string }) => r.name === 'SUPERADMIN')).toBeUndefined();
    const user = roles.find((r: { name: string }) => r.name === 'USER');
    expect(user.base).toBe(true);
    expect(user.permissions).toContain('conversations.reply'); // calculado del traductor

    const catalogo = await (await pedir(duena, '/roles/catalogo')).json();
    const item = catalogo.find((c: { permission: string }) => c.permission === 'crm.contacts.read');
    expect(item.moduleId).toBe('crm');
    expect(typeof item.active).toBe('boolean');
  });

  it('clona, edita permisos (los base inmutables) y el guard OBEDECE al custom', async () => {
    const creado = await pedir(duena, '/roles', {
      method: 'POST',
      body: JSON.stringify({ name: 'Recepcionista', cloneFrom: 'USER' }),
    });
    expect(creado.status).toBe(201);
    const rol = await creado.json();
    expect(rol.clonedFrom).toBe('USER');
    expect(rol.permissions).toContain('conversations.reply'); // heredó del USER

    // Editar: solo lectura de conversaciones — sin responder ni contactos.
    const editado = await pedir(duena, `/roles/${rol.id}`, {
      method: 'PUT',
      body: JSON.stringify({ permissions: ['tenant.read', 'conversations.read'] }),
    });
    expect(editado.status).toBe(200);

    // Un base no se edita ni con el id correcto.
    const roles = await (await pedir(duena, '/roles')).json();
    const baseUser = roles.find((r: { name: string }) => r.name === 'USER');
    expect(
      (await pedir(duena, `/roles/${baseUser.id}`, { method: 'PUT', body: JSON.stringify({ permissions: [] }) })).status,
    ).toBe(400);

    // Asignar y probar EL GUARD: lee sí, responde no.
    const asignado = await pedir(duena, '/roles/assign', {
      method: 'POST',
      body: JSON.stringify({ userId: recepcionista, roleId: rol.id }),
    });
    expect(asignado.status).toBe(201);

    expect((await pedir(recepcionista, '/conversations')).status).toBe(200); // conversations.read ✓
    expect((await pedir(recepcionista, '/contacts')).status).toBe(403); // sin crm.contacts.read

    // Auditado + eventos.
    const eventos = await admin.query(
      `SELECT name FROM outbox WHERE tenant_id = $1 AND name IN ('role.created','role.assigned') ORDER BY id`,
      [tenant],
    );
    expect(eventos.rows.map((e) => e.name)).toEqual(['role.created', 'role.assigned']);
    const audit = await admin.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action LIKE 'authorization.role%'`,
      [tenant],
    );
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(3); // create + update + assign
  });

  it('permisos piratas y de plataforma se rechazan', async () => {
    const roles = await (await pedir(duena, '/roles')).json();
    const custom = roles.find((r: { base: boolean }) => !r.base);
    expect(
      (await pedir(duena, `/roles/${custom.id}`, { method: 'PUT', body: JSON.stringify({ permissions: ['superpoderes.todo'] }) })).status,
    ).toBe(400);
    expect(
      (await pedir(duena, `/roles/${custom.id}`, { method: 'PUT', body: JSON.stringify({ permissions: ['platform.tenants'] }) })).status,
    ).toBe(400);
  });
});

describe('nadie invita por encima de sí mismo (#532)', () => {
  /**
   * El check era `rol === 'ADMIN' && actor.role !== 'ADMIN' && ...`: comparaba
   * NOMBRES, que es lo que ADR-0008 prohíbe, y no veía el caso que importa —un
   * rol propio del negocio (#73) con más permisos que quien invita—. El grep de
   * CI tampoco lo vio, porque solo miraba `===`.
   *
   * El camino real: un ADMIN crea «Jefe de local» con `users.invite`. Esa
   * persona llega a la ruta de invitar, y el check solo le impedía invitar al
   * rol llamado literalmente ADMIN. Invitar a otro rol propio más poderoso que
   * el suyo pasaba sin problema.
   */
  it('un rol propio con users.invite no puede invitar a uno más poderoso', async () => {
    const jefeDeLocal = await (
      await pedir(duena, '/roles', {
        method: 'POST',
        body: JSON.stringify({ name: 'Jefe de local', cloneFrom: 'USER' }),
      })
    ).json();
    await pedir(duena, `/roles/${jefeDeLocal.id}`, {
      method: 'PUT',
      // Puede invitar y leer, nada más. En particular NO puede facturar.
      body: JSON.stringify({ permissions: ['tenant.read', 'users.read', 'users.invite'] }),
    });

    const encargado = await (
      await pedir(duena, '/roles', {
        method: 'POST',
        body: JSON.stringify({ name: 'Encargado', cloneFrom: 'USER' }),
      })
    ).json();
    await pedir(duena, `/roles/${encargado.id}`, {
      method: 'PUT',
      // `roles.manage` es de los que MANDAN: reparte poder. Por eso este rol
      // queda por encima del jefe de local, que solo puede invitar.
      body: JSON.stringify({ permissions: ['tenant.read', 'roles.manage'] }),
    });

    // El jefe de local pasa a serlo de verdad.
    await pedir(duena, '/roles/assign', {
      method: 'POST',
      body: JSON.stringify({ userId: recepcionista, roleId: jefeDeLocal.id }),
    });

    // Y ahora intenta invitar a alguien con un rol que ADMINISTRA más que él.
    const arriba = await pedir(recepcionista, '/equipo/invitaciones', {
      method: 'POST',
      body: JSON.stringify({ email: 'colado@ajeno.cl', rol: 'Encargado' }),
    });
    expect(arriba.status, 'un rol propio no puede invitar por encima de sí mismo').toBe(400);
    const cuerpo = await arriba.json();
    expect(cuerpo.code).toBe('ROLE_FORBIDDEN');
    // El mensaje es para quien atiende, no una lista de permisos.
    expect(cuerpo.message).toContain('puede administrar cosas que tú no administras');

    // Y no quedó la invitación: el rechazo no es solo el código de estado.
    const invitaciones = await admin.query(
      'SELECT count(*)::int AS n FROM invitations WHERE tenant_id = $1 AND lower(email) = $2',
      [tenant, 'colado@ajeno.cl'],
    );
    expect(invitaciones.rows[0].n).toBe(0);

    // Lo que SÍ puede: invitar a un rol que no pasa de lo suyo.
    const iguales = await pedir(recepcionista, '/equipo/invitaciones', {
      method: 'POST',
      body: JSON.stringify({ email: 'otro@local.cl', rol: 'Jefe de local' }),
    });
    expect(iguales.status, 'invitar a su propio rol tiene que poder').toBe(201);
  });

  it('el ADMIN sigue pudiendo invitar a cualquier rol del negocio', async () => {
    // Lo que no puede cambiar: un ADMIN tiene todo lo que no es `platform.*`,
    // así que cualquier rol del negocio es un subconjunto suyo. Si esto falla,
    // la comparación por permisos rompió el caso normal.
    for (const rol of ['ADMIN', 'SUPERVISOR', 'USER']) {
      const r = await pedir(duena, '/equipo/invitaciones', {
        method: 'POST',
        body: JSON.stringify({ email: `nuevo-${rol.toLowerCase()}@pyme.cl`, rol }),
      });
      expect(r.status, `el ADMIN no pudo invitar a ${rol}`).toBe(201);
    }
  });
});

describe('delegar el onboarding sigue sirviendo (#556)', () => {
  /**
   * La primera versión de «nadie invita por encima de sí mismo» comparaba el
   * conjunto ENTERO de permisos, y eso rompía justo el caso que la delegación
   * existe para servir: un rol angosto con `users.invite` no podía invitar a
   * NADIE, porque cualquier rol asignable tiene más permisos que él — hasta un
   * USER quedaba «por encima».
   *
   * Lo cazó una revisión de código, no una prueba: la mía afirmaba que el jefe
   * de local podía invitar a su propio rol, y eso seguía pasando. El caso que
   * importa —invitar a un USER normal, que es para lo que se delega— no estaba
   * probado.
   */
  it('un rol angosto con users.invite SÍ puede incorporar a un vendedor', async () => {
    const soloInvita = await (
      await pedir(duena, '/roles', {
        method: 'POST',
        body: JSON.stringify({ name: 'Encargada de turno', cloneFrom: 'USER' }),
      })
    ).json();
    await pedir(duena, `/roles/${soloInvita.id}`, {
      method: 'PUT',
      body: JSON.stringify({ permissions: ['tenant.read', 'users.read', 'users.invite'] }),
    });
    await pedir(duena, '/roles/assign', {
      method: 'POST',
      body: JSON.stringify({ userId: recepcionista, roleId: soloInvita.id }),
    });

    // Un USER tiene MUCHOS permisos que ella no tiene —responder, contactos,
    // agenda— y ninguno de ellos reparte poder. Tiene que poder.
    const r = await pedir(recepcionista, '/equipo/invitaciones', {
      method: 'POST',
      body: JSON.stringify({ email: 'vendedora-nueva@pyme.cl', rol: 'USER' }),
    });
    expect(r.status, 'delegar el onboarding y no poder incorporar a nadie es no delegar nada').toBe(
      201,
    );
  });

  it('pero no puede incorporar a alguien que reparta roles', async () => {
    const r = await pedir(recepcionista, '/equipo/invitaciones', {
      method: 'POST',
      body: JSON.stringify({ email: 'jefa@pyme.cl', rol: 'ADMIN' }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).code).toBe('ROLE_FORBIDDEN');
  });

  it('la invitación a un rol PROPIO se puede aceptar de verdad', async () => {
    /**
     * La regresión que encontró la revisión: `acceptInvitation` buscaba el rol
     * solo entre los base, así que invitar a un rol propio creaba una
     * invitación MUERTA — con su correo y su enlace— que fallaba al aceptarla
     * con «Rol desconocido». Y la fila quedaba sin aceptar, bloqueando reinvitar
     * a esa dirección hasta que venciera.
     *
     * Mi prueba anterior afirmaba el 201 de la invitación y nunca la aceptaba:
     * verde con la función rota de punta a punta.
     */
    const rol = await (
      await pedir(duena, '/roles', {
        method: 'POST',
        body: JSON.stringify({ name: 'Cajera', cloneFrom: 'USER' }),
      })
    ).json();

    const invitada = randomUUID();
    const creada = await pedir(duena, '/equipo/invitaciones', {
      method: 'POST',
      body: JSON.stringify({ email: 'cajera@pyme.cl', rol: 'Cajera' }),
    });
    expect(creada.status).toBe(201);
    // El token viaja dentro del enlace, una sola vez: sirve para pasarlo a mano
    // cuando el correo no está configurado.
    const { enlace } = await creada.json();
    const token = String(enlace).split('/').pop();
    expect(token, 'la invitación tiene que traer su enlace con el token').toBeTruthy();

    const aceptada = await fetch(`${base}/v1/invitaciones/${token}/aceptar`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await firmar(invitada)}`,
        'Content-Type': 'application/json',
      },
    });
    expect(
      aceptada.status,
      'la invitación a un rol propio no se podía aceptar',
    ).toBe(201);

    // Y quedó con ESE rol, no con el base del que se clonó.
    const fila = await admin.query(
      `SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id
        WHERE ur.tenant_id = $1 AND ur.user_id = $2`,
      [tenant, invitada],
    );
    expect(fila.rows[0]?.name).toBe('Cajera');
    expect(rol.id).toBeTruthy();
  });
});
