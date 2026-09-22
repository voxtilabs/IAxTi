import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createAgent, updateAgent } from '../application/agents';
import { porQueNoHaySugerencia } from '../application/por-que-no-sugirio';

/**
 * Por qué esta conversación no tiene sugerencia (#436).
 *
 * El copiloto se salta el trabajo en casos legítimos y el motivo se
 * devolvía en el resultado del job, que no mira nadie: desde la bandeja,
 * las cinco causas se veían igual —el panel vacío— y se arreglan en
 * lugares distintos. Dos de ellas ni siquiera son del negocio.
 */
const URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
let pool: Pool;
let tenant: string;
let conversacion: string;
const en = <T>(fn: (c: PoolClient) => Promise<T>) => withTenant(pool, tenant, fn);

beforeAll(async () => {
  pool = createPool(URL);
  await runMigrations(pool);
  const t = await pool.query("INSERT INTO tenants (name) VALUES ('por-que-no-sugirio') RETURNING id");
  tenant = t.rows[0].id;
  const c = await pool.query(
    `INSERT INTO contacts (tenant_id, name, phone, origin)
     VALUES ($1, 'Ana', '+56999000099', 'whatsapp') RETURNING id`,
    [tenant],
  );
  const v = await pool.query(
    `INSERT INTO conversations (tenant_id, contact_id, channel, last_inbound_at)
     VALUES ($1, $2, 'whatsapp', now()) RETURNING id`,
    [tenant, c.rows[0].id],
  );
  conversacion = v.rows[0].id;
});

afterAll(async () => {
  await pool.query('DELETE FROM agent_executions WHERE tenant_id = $1', [tenant]);
  await pool.query('DELETE FROM agents WHERE tenant_id = $1', [tenant]);
  await pool.end();
});

/**
 * La llave se INYECTA en vez de tocar `process.env`: esa variable es del
 * proceso y vitest corre los archivos en hilos que lo comparten, así que
 * ponerla o borrarla acá se la pone o se la borra a los que corren al lado.
 */
const preguntar = (hayLlave = true) =>
  en((c) =>
    porQueNoHaySugerencia(
      c,
      { tenantId: tenant, conversationId: conversacion },
      { hayLlave: () => hayLlave },
    ),
  );

/** Una ejecución de sugerencia como la que deja el runtime. */
async function ejecucion(campos: { status: string; error?: string; output?: unknown; agentId: string }) {
  await pool.query(
    `INSERT INTO agent_executions
       (tenant_id, agent_id, task, provider, model, input, output, status, error, trace_id, latency_ms)
     VALUES ($1, $2, 'sugerir', 'google', 'gemini-flash-latest', '{}'::jsonb, $3, $4, $5, 'trace', 10)`,
    [tenant, campos.agentId, JSON.stringify(campos.output ?? {}), campos.status, campos.error ?? null],
  );
}

describe('por qué no hay sugerencia', () => {
  it('sin ningún asistente, dice que hay que crearlo', async () => {
    const r = await preguntar();
    expect(r.codigo).toBe('sin_asistente');
    expect(r.loArreglaElNegocio).toBe(true);
    expect(r.queHacer).toContain('Ajustes');
  });

  it('con el asistente APAGADO dice eso, que es otro arreglo', async () => {
    // "No hay ninguno" se arregla creando uno; "está apagado" es un
    // interruptor. Decir lo primero cuando pasa lo segundo manda a crear un
    // segundo asistente que tampoco va a contestar.
    const agente = await en((c) =>
      createAgent(c, { tenantId: tenant, name: 'Sofía', objetivo: 'vender' }),
    );
    await en((c) => updateAgent(c, { tenantId: tenant, agentId: agente.id, active: false }));
    expect((await preguntar()).codigo).toBe('asistente_apagado');
    await en((c) => updateAgent(c, { tenantId: tenant, agentId: agente.id, active: true }));
  });

  it('con asistente encendido y nada corrido: todavía está trabajando', async () => {
    // El copiloto vive en una cola y corre DESPUÉS del camino de entrada,
    // a propósito, para que la bandeja nunca espere a la IA.
    const r = await preguntar();
    expect(r.codigo).toBe('todavia_trabajando');
    expect(r.queHacer).toBeUndefined(); // no hay nada que hacer
  });

  it('sin saldo del proveedor: el negocio no tiene nada que arreglar', async () => {
    const agente = (await en((c) => createAgent(c, { tenantId: tenant, name: 'Otra' }))).id;
    await ejecucion({
      agentId: agente,
      status: 'failed',
      error: 'Your prepayment credits are depleted. Please recharge.',
    });
    const r = await preguntar();
    expect(r.codigo).toBe('sin_saldo');
    expect(r.loArreglaElNegocio).toBe(false);
    expect(r.queHacer).toContain('cosa nuestra');
  });

  it('la cuota del MES es del negocio, y se distingue del saldo del proveedor', async () => {
    // Son dos límites distintos: uno lo pone el producto y el negocio puede
    // subirlo; el otro es nuestra cuenta con el proveedor.
    const agente = (await en((c) => createAgent(c, { tenantId: tenant, name: 'Tercera' }))).id;
    await ejecucion({
      agentId: agente,
      status: 'failed',
      error: 'Se agotó la cuota de IA del mes (1000/1000).',
    });
    const r = await preguntar();
    expect(r.codigo).toBe('cuota_agotada');
    expect(r.loArreglaElNegocio).toBe(true);
  });

  it('una respuesta cortada no es "no se entendió"', async () => {
    // Son dos cosas distintas: una se arregla sola en la próxima entrada y
    // la otra hay que mirarla. Confundirlas manda a buscar donde no es.
    const agente = (await en((c) => createAgent(c, { tenantId: tenant, name: 'Cuarta' }))).id;
    await ejecucion({ agentId: agente, status: 'ok', output: { text: 'a medio', truncada: true } });
    expect((await preguntar()).codigo).toBe('respuesta_cortada');
  });

  it('sin llave en el ambiente manda todo lo demás', async () => {
    // Si no hay con qué generar, que además falte el asistente no cambia
    // nada — y dos problemas a la vez hacen que no se arregle ninguno.
    const r = await preguntar(false);
    expect(r.codigo).toBe('sin_llave');
    expect(r.loArreglaElNegocio).toBe(false);
  });
});
