import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { acceptInvitation, createInvitation, upsertProfile } from '../application/invitations';
import { quienEs, quienesSon, quienFue } from '../application/quien';

/**
 * Quién hizo esto (#697).
 *
 * Nueve columnas guardaban el autor de cada acción —quién apagó la IA, quién
 * lanzó la campaña, quién aprobó lo que propuso el agente— y ninguna pantalla
 * lo mostraba.
 *
 * Lo que estas pruebas cuidan es el criterio 2 del issue: **un nombre, no un
 * UUID**. Y la distinción que hace falta para cumplirlo: alguien que ya no está
 * en el tenant no se muestra como identificador, se dice que ya no está.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
const conNombre = randomUUID();
const sinPerfil = randomUUID();
const queSeFue = randomUUID();
const desconocido = randomUUID();

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  tenant = (await admin.query("INSERT INTO tenants (name) VALUES ('quien-#697') RETURNING id")).rows[0].id;

  // Carla: en el equipo y con perfil.
  const inv = await withTenant(admin, tenant, (c) =>
    createInvitation(c, { tenantId: tenant, email: 'carla@negocio.cl', roleName: 'ADMIN' }),
  );
  await withTenant(admin, tenant, (c) => acceptInvitation(c, { token: inv.token, userId: conNombre }));
  await withTenant(admin, tenant, (c) => upsertProfile(c, { userId: conNombre, name: 'Carla' }));

  // En el equipo, sin haber completado el perfil.
  const inv2 = await withTenant(admin, tenant, (c) =>
    createInvitation(c, { tenantId: tenant, email: 'nuevo@negocio.cl', roleName: 'USER' }),
  );
  await withTenant(admin, tenant, (c) => acceptInvitation(c, { token: inv2.token, userId: sinPerfil }));

  // Con perfil, pero fuera del equipo: lanzó la campaña del mes pasado y se fue.
  await withTenant(admin, tenant, (c) => upsertProfile(c, { userId: queSeFue, name: 'Diego' }));
});

afterAll(async () => {
  await admin.query('DELETE FROM user_roles WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM invitations WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM user_profiles WHERE user_id = ANY($1::uuid[])', [
    [conNombre, sinPerfil, queSeFue],
  ]);
  await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  await admin.end();
});

describe('quién hizo esto (#697)', () => {
  it('devuelve el nombre, que es lo que la pantalla muestra', async () => {
    const q = await withTenant(admin, tenant, (c) => quienEs(c, tenant, conNombre));
    expect(q).toEqual({ userId: conNombre, nombre: 'Carla', enElEquipo: true });
  });

  it('en el equipo pero sin perfil: nombre null, y eso NO es un error', async () => {
    // La pantalla dirá «alguien del equipo»: sabemos que es del equipo, no cómo
    // se llama, y decirlo así es más honesto que mostrar un id.
    const q = await withTenant(admin, tenant, (c) => quienEs(c, tenant, sinPerfil));
    expect(q).toEqual({ userId: sinPerfil, nombre: null, enElEquipo: true });
  });

  it('quien ya no está en el equipo se distingue de quien sí', async () => {
    // Pasa de verdad: quien lanzó la campaña del mes pasado pudo haberse ido, y
    // la campaña sigue ahí con su autor.
    const q = await withTenant(admin, tenant, (c) => quienEs(c, tenant, queSeFue));
    expect(q).toEqual({ userId: queSeFue, nombre: 'Diego', enElEquipo: false });
  });

  it('un id que no existe no revienta: se resuelve como fuera del equipo', async () => {
    const mapa = await withTenant(admin, tenant, (c) => quienesSon(c, tenant, [desconocido]));
    expect(quienFue(mapa, desconocido)).toEqual({
      userId: desconocido, nombre: null, enElEquipo: false,
    });
  });

  it('sin tenant no se afirma pertenencia: null, no false', async () => {
    // Ámbito plataforma. Un SuperAdmin que apagó el Agente General no pertenece
    // al equipo de ningún negocio: decir «ya no está en el equipo» de alguien
    // que nunca estuvo sería afirmar algo falso.
    const q = await withTenant(admin, tenant, (c) => quienEs(c, null, conNombre));
    expect(q).toEqual({ userId: conNombre, nombre: 'Carla', enElEquipo: null });
  });

  it('varios de una vez, sin repetir ni preguntar por los nulos', async () => {
    const mapa = await withTenant(admin, tenant, (c) =>
      quienesSon(c, tenant, [conNombre, conNombre, queSeFue, null, undefined, '']),
    );
    expect(mapa.size).toBe(2);
    expect(mapa.get(conNombre)?.nombre).toBe('Carla');
    expect(mapa.get(queSeFue)?.enElEquipo).toBe(false);
  });

  it('una lista sin ids no va a la base', async () => {
    const mapa = await quienesSon(
      { query: () => { throw new Error('no debería consultar'); } } as never,
      tenant,
      [null, undefined],
    );
    expect(mapa.size).toBe(0);
  });

  it('quienFue de un null es null: no hay a quién atribuirlo', () => {
    // Un link de pago que generó una automatización no tiene persona detrás, y
    // eso es un dato — no un hueco que haya que rellenar con algo.
    expect(quienFue(new Map(), null)).toBeNull();
    expect(quienFue(undefined, undefined)).toBeNull();
    expect(quienFue(new Map(), '')).toBeNull();
  });
});
