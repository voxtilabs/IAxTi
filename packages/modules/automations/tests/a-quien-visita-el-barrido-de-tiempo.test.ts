import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createRule, setRuleActive } from '../application/rules';

/**
 * A quién visita el barrido de reglas de tiempo (#733, ADR-0026).
 *
 * Recorría TODOS los tenants vivos y, por cada uno, abría una transacción y
 * leía su zona horaria para después descubrir que no tiene ninguna regla de
 * tiempo. Medido el 09/10 con 1.283 tenants: 4,5 ms cada uno, ~5,8 s el barrido
 * entero.
 *
 * La mayoría de los negocios no tiene ninguna regla de tiempo encendida, así que
 * el filtro saca casi todo el trabajo. Lo que estas pruebas cuidan es que no se
 * salte a quien SÍ la tiene.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const TODOS = ['conversations', 'crm'];

let admin: Pool;
const tenants: string[] = [];

async function nuevoTenant(nombre: string): Promise<string> {
  const id = (await admin.query('INSERT INTO tenants (name) VALUES ($1) RETURNING id', [nombre]))
    .rows[0].id;
  tenants.push(id);
  return id;
}

/** Una regla con disparador de tiempo, opcionalmente apagada. */
async function reglaDeTiempo(tenantId: string, activa = true): Promise<void> {
  const regla = await withTenant(admin, tenantId, (c) =>
    createRule(c, {
      tenantId,
      name: `sin respuesta ${Math.random().toString(36).slice(2, 7)}`,
      trigger: { kind: 'time', time: { base: 'no_reply', hours: 24 } },
      conditions: [],
      actions: [{ kind: 'add_note', params: { body: 'lleva un día esperando' } }],
      actor: 'test',
    }),
  );
  if (activa) {
    await withTenant(admin, tenantId, (c) =>
      setRuleActive(c, { tenantId, ruleId: regla.id, active: true, activeModules: TODOS, actor: 'test' }),
    );
  }
}

const visitados = async (): Promise<string[]> =>
  (await admin.query('SELECT tenant_id FROM tenants_con_reglas_de_tiempo()')).rows.map(
    (f) => f.tenant_id as string,
  );

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
});

afterAll(async () => {
  for (const t of tenants) {
    for (const tabla of ['rule_runs', 'rules', 'outbox']) {
      await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [t]);
    }
  }
  await admin.end();
});

describe('a quién visita el barrido de tiempo (#733)', () => {
  it('con una regla de tiempo ACTIVA, el tenant entra', async () => {
    const id = await nuevoTenant('con-regla-de-tiempo');
    await reglaDeTiempo(id);
    expect(await visitados()).toContain(id);
  });

  it('con la regla apagada, no: una regla apagada no corre', async () => {
    const id = await nuevoTenant('regla-apagada');
    await reglaDeTiempo(id, false);
    expect(await visitados()).not.toContain(id);
  });

  it('sin ninguna regla, tampoco. Es el caso de la mayoría', async () => {
    const id = await nuevoTenant('sin-reglas');
    expect(await visitados()).not.toContain(id);
  });

  it('con una regla de EVENTO y ninguna de tiempo, no entra', async () => {
    // El barrido de tiempo no las corre: las de evento las dispara el outbox.
    // Visitar a este tenant sería trabajo que no hace nada.
    const id = await nuevoTenant('solo-reglas-de-evento');
    const regla = await withTenant(admin, id, (c) =>
      createRule(c, {
        tenantId: id,
        name: 'al crearse la conversación',
        trigger: { kind: 'event', event: 'conversation.created' },
        conditions: [],
        actions: [{ kind: 'add_note', params: { body: 'nueva' } }],
        actor: 'test',
      }),
    );
    await withTenant(admin, id, (c) =>
      setRuleActive(c, { tenantId: id, ruleId: regla.id, active: true, activeModules: TODOS, actor: 'test' }),
    );
    expect(await visitados()).not.toContain(id);
  });

  it('un tenant borrado no entra, aunque tenga la regla encendida', async () => {
    const id = await nuevoTenant('borrado-con-regla');
    await reglaDeTiempo(id);
    await admin.query("UPDATE tenants SET state = 'deleted' WHERE id = $1", [id]);
    expect(await visitados()).not.toContain(id);
  });

  it('la función devuelve SOLO ids', async () => {
    const r = await admin.query('SELECT * FROM tenants_con_reglas_de_tiempo() LIMIT 1');
    expect(r.fields.map((f) => f.name)).toEqual(['tenant_id']);
  });

  it('no repite un tenant que tiene varias reglas de tiempo', async () => {
    // `DISTINCT`: sin eso, un negocio con cinco reglas se visitaría cinco veces
    // y el filtro empeoraría justo el caso que venía a mejorar.
    const id = await nuevoTenant('tres-reglas');
    await reglaDeTiempo(id);
    await reglaDeTiempo(id);
    await reglaDeTiempo(id);
    const lista = await visitados();
    expect(lista.filter((t) => t === id)).toHaveLength(1);
  });
});
