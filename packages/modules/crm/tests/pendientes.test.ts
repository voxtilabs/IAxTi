import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createContact } from '../application/contacts';
import { completeActivity, createActivity, listActivities } from '../application/activities';

/**
 * Lo que hay que hacer, junto (#454).
 *
 * Las actividades se creaban —desde la ficha y desde el asistente—, el
 * barrido las marcaba vencidas y publicaba el aviso, y no había forma de
 * verlas juntas: la única puerta era abrir la ficha del contacto exacto.
 *
 * El orden es lo que hace útil la lista, así que es lo que se prueba.
 */
const URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
let pool: Pool;
let tenant: string;
let contacto: string;
const duena = '11111111-1111-4111-8111-111111111111';
const otra = '22222222-2222-4222-8222-222222222222';
const en = <T,>(fn: (c: PoolClient) => Promise<T>) => withTenant(pool, tenant, fn);

const dias = (n: number) => new Date(Date.now() + n * 86_400_000);

beforeAll(async () => {
  pool = createPool(URL);
  await runMigrations(pool);
  const t = await pool.query("INSERT INTO tenants (name) VALUES ('pendientes') RETURNING id");
  tenant = t.rows[0].id;
  const c = await en((cl) =>
    createContact(cl, { tenantId: tenant, phone: '+56999000055', name: 'Ana' }),
  );
  contacto = c.id;
});

afterAll(async () => {
  await pool.query('DELETE FROM activities WHERE tenant_id = $1', [tenant]);
  await pool.query('DELETE FROM contacts WHERE tenant_id = $1', [tenant]);
  await pool.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  await pool.end();
});

async function actividad(campos: {
  title: string;
  dueAt?: Date | null;
  ownerId?: string;
  actorKind?: 'user' | 'agent';
}) {
  return en((c) =>
    createActivity(c, {
      tenantId: tenant,
      contactId: contacto,
      type: 'tarea',
      title: campos.title,
      dueAt: campos.dueAt ?? undefined,
      ownerId: campos.ownerId,
      actorKind: campos.actorKind,
    }),
  );
}

describe('la lista de pendientes', () => {
  it('lo vencido va primero, después lo que tiene fecha, y al final lo que no', async () => {
    // Una lista por fecha de creación entierra lo atrasado debajo de lo que
    // recién se anotó, que es justo al revés de para qué se mira.
    await actividad({ title: 'sin fecha' });
    await actividad({ title: 'la semana que viene', dueAt: dias(7) });
    await actividad({ title: 'vencida', dueAt: dias(-3) });
    await actividad({ title: 'mañana', dueAt: dias(1) });

    const lista = await en((c) => listActivities(c, { tenantId: tenant }));
    expect(lista.map((a) => a.title)).toEqual([
      'vencida',
      'mañana',
      'la semana que viene',
      'sin fecha',
    ]);
  });

  it('trae el nombre del contacto: una tarea sin a quién no se puede hacer', async () => {
    const [primera] = await en((c) => listActivities(c, { tenantId: tenant }));
    expect(primera.contactName).toBe('Ana');
  });

  it('las hechas no aparecen, salvo que se pidan', async () => {
    const hecha = await actividad({ title: 'ya la hice', dueAt: dias(-1) });
    await en((c) => completeActivity(c, { tenantId: tenant, activityId: hecha.id }));

    const pendientes = await en((c) => listActivities(c, { tenantId: tenant }));
    expect(pendientes.map((a) => a.title)).not.toContain('ya la hice');

    const todas = await en((c) => listActivities(c, { tenantId: tenant, incluirHechas: true }));
    expect(todas.map((a) => a.title)).toContain('ya la hice');
  });

  it('filtrar por persona INCLUYE las que no son de nadie', async () => {
    // Una tarea sin dueño es de todos; esconderla la deja sin hacer para
    // siempre, que es justo lo que esta pantalla viene a evitar.
    await actividad({ title: 'de la dueña', ownerId: duena, dueAt: dias(2) });
    await actividad({ title: 'de la otra', ownerId: otra, dueAt: dias(2) });

    const mias = await en((c) => listActivities(c, { tenantId: tenant, ownerId: duena }));
    const titulos = mias.map((a) => a.title);
    expect(titulos).toContain('de la dueña');
    expect(titulos).toContain('sin fecha'); // sin dueño
    expect(titulos).not.toContain('de la otra');
  });

  it('se sabe si la creó el asistente o una persona', async () => {
    // `crm.create_activity` es una de las dos herramientas que la IA puede
    // escribir: lo que anotó se revisa distinto de lo que anotó uno mismo.
    const dela = await actividad({ title: 'llamar al cliente', actorKind: 'agent', dueAt: dias(1) });
    const mia = await actividad({ title: 'cotizar', actorKind: 'user', dueAt: dias(1) });

    const lista = await en((c) => listActivities(c, { tenantId: tenant }));
    expect(lista.find((a) => a.id === dela.id)?.createdByKind).toBe('agent');
    expect(lista.find((a) => a.id === mia.id)?.createdByKind).toBe('user');
  });
});
