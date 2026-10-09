import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../src/client';
import { runMigrations } from '../src/migrate';
import { idsDeTenants, porCadaTenant } from '../src/tenant';

/**
 * A quiénes visita un barrido (#580, ADR-0026).
 *
 * `porCadaTenant` recorría TODOS los tenants vivos. Fue deliberado —#286: un
 * barrido global no puede leer tablas con RLS desde fuera de `withTenant`— y el
 * precio resultó ser un problema antes de lo previsto: medido el 09/10, visitar
 * un tenant SIN trabajo cuesta 4,5 ms, así que mil tenants son minutos de un
 * cron haciendo nada.
 *
 * `opts.ids` es la salida: quien sepa a quiénes hay que visitar los pasa. Lo que
 * estas pruebas cuidan es que esa lista se respete **exactamente** — ni de más,
 * que sería volver al problema, ni de menos, que sería perder trabajo.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
const creados: string[] = [];

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  for (const nombre of ['visita-a', 'visita-b', 'visita-c']) {
    const r = await admin.query("INSERT INTO tenants (name) VALUES ($1) RETURNING id", [nombre]);
    creados.push(r.rows[0].id);
  }
});

afterAll(async () => admin.end());

describe('porCadaTenant visita exactamente a quien se le diga (#580)', () => {
  it('con una lista, visita esos y solo esos', async () => {
    const dos = creados.slice(0, 2);
    const visitados = await porCadaTenant(admin, async (_c, tenantId) => tenantId, { ids: dos });
    expect(visitados).toEqual(dos);
  });

  it('respeta el ORDEN de la lista: el barrido es determinista', async () => {
    const alReves = [...creados].reverse();
    const visitados = await porCadaTenant(admin, async (_c, tenantId) => tenantId, { ids: alReves });
    expect(visitados).toEqual(alReves);
  });

  it('con una lista vacía no visita a nadie, y eso NO es "a todos"', async () => {
    // El caso que importa: si una lista vacía cayera al comportamiento por
    // defecto, un barrido sin trabajo recorrería la base entera — exactamente
    // el problema que esto viene a arreglar.
    const visitados = await porCadaTenant(admin, async (_c, tenantId) => tenantId, { ids: [] });
    expect(visitados).toEqual([]);
  });

  it('sin lista sigue visitando a todos los vivos, como siempre', async () => {
    const todos = await idsDeTenants(admin);
    expect(todos.length).toBeGreaterThan(creados.length);
    for (const id of creados) expect(todos).toContain(id);
  });

  it('con lista, no consulta `tenants`: preguntar dos veces lo mismo es el costo que se quitó', async () => {
    const reventar = {
      query: () => {
        throw new Error('no debería consultar tenants');
      },
    } as unknown as Pool;
    expect(await idsDeTenants(reventar, { ids: creados })).toEqual(creados);
  });

  it('un tenant que falla no deja sin visitar a los demás', async () => {
    // Esto ya estaba y sigue valiendo con la lista: el barrido que se cae en el
    // primer tenant deja a todos los demás sin servicio y solo se nota en logs.
    const fallos: string[] = [];
    const visitados = await porCadaTenant(
      admin,
      async (_c, tenantId) => {
        if (tenantId === creados[0]) throw new Error('reventó');
        return tenantId;
      },
      { ids: creados, alFallar: (t) => fallos.push(t) },
    );
    expect(fallos).toEqual([creados[0]]);
    expect(visitados).toEqual(creados.slice(1));
  });
});
