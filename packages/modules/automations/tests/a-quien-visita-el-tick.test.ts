import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createSequence } from '../application/sequences';

/**
 * A quién visita el tick de secuencias (#740, ADR-0026).
 *
 * Recorría TODOS los tenants vivos, abriendo una transacción por cada uno para
 * descubrir que no tiene ninguna inscripción vencida. Medido el 09/10 con 1.283
 * tenants: 4,5 ms cada uno, ~5,8 s el tick entero — y corre cada pocos minutos,
 * como el de recordatorios.
 *
 * Es el cuarto barrido de esta familia y no salió en #733 porque esa noche la
 * base tenía menos tenants: estas pruebas entraban justo dentro del límite de
 * vitest. Cada corrida de las suites agrega tenants, así que el problema se fue
 * haciendo visible solo.
 *
 * Lo que estas pruebas cuidan es que **no se pierda un paso**. Un tick que
 * visita menos y deja una secuencia sin avanzar es peor que uno lento: el
 * cliente se queda esperando un mensaje que el negocio cree que salió.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
const tenants: string[] = [];

/**
 * Un tenant con una inscripción `running` cuyo próximo paso vence en `horas`
 * (negativo = ya venció), o sin ninguna inscripción.
 */
async function tenantConPaso(horas: number | null, estado = 'running'): Promise<string> {
  const id = (
    await admin.query("INSERT INTO tenants (name) VALUES ('tick-secuencias') RETURNING id")
  ).rows[0].id;
  tenants.push(id);
  if (horas === null) return id;

  const seq = await withTenant(admin, id, (c) =>
    createSequence(c, {
      tenantId: id,
      name: `seguimiento-${Math.random().toString(36).slice(2, 7)}`,
      steps: [{ afterHours: 24, action: { kind: 'send_message', params: { body: 'hola' } } }],
      actor: 'test',
    }),
  );
  await admin.query(
    `INSERT INTO sequence_enrollments
       (tenant_id, sequence_id, conversation_id, contact_id, status, next_run_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6))`,
    [id, seq.id, randomUUID(), randomUUID(), estado, horas],
  );
  return id;
}

const visitados = async (): Promise<string[]> =>
  (await admin.query('SELECT tenant_id FROM tenants_con_secuencias_vencidas()')).rows.map(
    (f) => f.tenant_id as string,
  );

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
});

afterAll(async () => {
  for (const t of tenants) {
    for (const tabla of ['sequence_enrollments', 'sequences', 'outbox']) {
      await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [t]);
    }
  }
  await admin.end();
});

describe('a quién visita el tick de secuencias (#740)', () => {
  it('con un paso vencido, el tenant entra', async () => {
    const id = await tenantConPaso(-1);
    expect(await visitados()).toContain(id);
  });

  it('con el próximo paso en el futuro, no entra todavía', async () => {
    const id = await tenantConPaso(5);
    expect(await visitados()).not.toContain(id);
  });

  it('una inscripción detenida no se visita, aunque su fecha ya pasó', async () => {
    // Detenerla a mano es una decisión del negocio: el tick no tiene que
    // volver a mirarla nunca.
    const id = await tenantConPaso(-3, 'stopped');
    expect(await visitados()).not.toContain(id);
  });

  it('una completada tampoco', async () => {
    const id = await tenantConPaso(-3, 'completed');
    expect(await visitados()).not.toContain(id);
  });

  it('sin ninguna inscripción, no entra. Es el caso de la mayoría', async () => {
    const id = await tenantConPaso(null);
    expect(await visitados()).not.toContain(id);
  });

  it('un tenant borrado no entra, aunque tenga un paso vencido', async () => {
    const id = await tenantConPaso(-2);
    await admin.query("UPDATE tenants SET state = 'deleted' WHERE id = $1", [id]);
    expect(await visitados()).not.toContain(id);
  });

  it('la función devuelve SOLO ids', async () => {
    const r = await admin.query('SELECT * FROM tenants_con_secuencias_vencidas() LIMIT 1');
    expect(r.fields.map((f) => f.name)).toEqual(['tenant_id']);
  });

  it('no repite al que tiene varias inscripciones vencidas', async () => {
    // `DISTINCT`: sin eso, un negocio con cincuenta inscripciones vencidas se
    // visitaría cincuenta veces y el filtro empeoraría lo que vino a mejorar.
    const id = await tenantConPaso(-1);
    const seq = await withTenant(admin, id, (c) =>
      createSequence(c, {
        tenantId: id,
        name: 'otra',
        steps: [{ afterHours: 1, action: { kind: 'send_message', params: { body: 'hola' } } }],
        actor: 'test',
      }),
    );
    await admin.query(
      `INSERT INTO sequence_enrollments
         (tenant_id, sequence_id, conversation_id, contact_id, status, next_run_at)
       VALUES ($1, $2, $3, $4, 'running', now() - interval '2 hours')`,
      [id, seq.id, randomUUID(), randomUUID()],
    );
    const lista = await visitados();
    expect(lista.filter((t) => t === id)).toHaveLength(1);
  });
});
