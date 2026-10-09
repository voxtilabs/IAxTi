import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations } from '@iaxti/db';

/**
 * A quién visita la sincronización de plantillas (#743, ADR-0026).
 *
 * `plantillas-sync` recorría TODOS los tenants vivos y abría una transacción por
 * cada uno solo para preguntar «¿tienes alguna plantilla pendiente?». La consulta
 * de adentro ya estaba bien pensada —si no hay nada esperando, no molesta al
 * proveedor— pero la TRANSACCIÓN se pagaba igual, por cada tenant, en cada
 * vuelta: medido el 09/10 con 1.283 tenants, 4,5 ms cada uno y ~5,8 s el barrido.
 *
 * En local eran tres pruebas rojas por timeout, también en `staging` limpio.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
const tenants: string[] = [];

/** Un tenant con una plantilla en el estado dado, o sin ninguna. */
async function tenantConPlantilla(estado: string | null): Promise<string> {
  const id = (
    await admin.query("INSERT INTO tenants (name) VALUES ('sync-plantillas') RETURNING id")
  ).rows[0].id;
  tenants.push(id);
  if (estado === null) return id;
  await admin.query(
    `INSERT INTO whatsapp_templates (tenant_id, name, language, category, body, status)
     VALUES ($1, $2, 'es_CL', 'utility', 'Hola {{1}}', $3)`,
    [id, `recordatorio_${Math.random().toString(36).slice(2, 8)}`, estado],
  );
  return id;
}

const visitados = async (): Promise<string[]> =>
  (await admin.query('SELECT tenant_id FROM tenants_con_plantillas_en_revision()')).rows.map(
    (f) => f.tenant_id as string,
  );

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
});

afterAll(async () => {
  for (const t of tenants) {
    await admin.query('DELETE FROM whatsapp_templates WHERE tenant_id = $1', [t]);
    await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [t]);
  }
  await admin.end();
});

describe('a quién visita la sincronización de plantillas (#743)', () => {
  it('con una plantilla en revisión, el tenant entra', async () => {
    const id = await tenantConPlantilla('pending');
    expect(await visitados()).toContain(id);
  });

  it('con solo borradores, no: a Meta no se le ha mandado nada', async () => {
    const id = await tenantConPlantilla('draft');
    expect(await visitados()).not.toContain(id);
  });

  it('con solo aprobadas, tampoco: ya no hay nada que preguntar', async () => {
    const id = await tenantConPlantilla('approved');
    expect(await visitados()).not.toContain(id);
  });

  it('con una rechazada, tampoco', async () => {
    const id = await tenantConPlantilla('rejected');
    expect(await visitados()).not.toContain(id);
  });

  it('sin ninguna plantilla, no entra. Es el caso de la mayoría', async () => {
    const id = await tenantConPlantilla(null);
    expect(await visitados()).not.toContain(id);
  });

  it('un tenant borrado no entra, aunque tenga una en revisión', async () => {
    const id = await tenantConPlantilla('pending');
    await admin.query("UPDATE tenants SET state = 'deleted' WHERE id = $1", [id]);
    expect(await visitados()).not.toContain(id);
  });

  it('la función devuelve SOLO ids', async () => {
    const r = await admin.query('SELECT * FROM tenants_con_plantillas_en_revision() LIMIT 1');
    expect(r.fields.map((f) => f.name)).toEqual(['tenant_id']);
  });

  it('no repite al que tiene varias en revisión', async () => {
    const id = await tenantConPlantilla('pending');
    await admin.query(
      `INSERT INTO whatsapp_templates (tenant_id, name, language, category, body, status)
       VALUES ($1, $2, 'es_CL', 'utility', 'Otra {{1}}', 'pending')`,
      [id, `otra_${Math.random().toString(36).slice(2, 8)}`],
    );
    const lista = await visitados();
    expect(lista.filter((t) => t === id)).toHaveLength(1);
  });
});
