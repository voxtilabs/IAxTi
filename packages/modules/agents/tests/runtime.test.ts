import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createAgent } from '../application/agents';
import { listExecutions, runAgentTask } from '../application/runtime';

/**
 * Qué herramientas consultó la corrida (#699).
 *
 * `agent_executions.tools_called` existe desde `0001_agents.sql`, con
 * `NOT NULL DEFAULT '[]'::jsonb`, y ninguna línea de código la tocaba: guardaba
 * `[]` en cada corrida desde el primer día. El dato estaba metido en el jsonb de
 * `output` y tampoco lo leía nadie — un dato en dos casas y leído en ninguna.
 *
 * Importa porque es lo que hace creíble al asistente. Cuando contesta algo raro la
 * pregunta es «¿de dónde sacó eso?», y la respuesta es si llamó a una herramienta o
 * lo dijo de memoria. En la tabla de corridas, una respuesta con el precio real y
 * una inventada se veían exactamente igual.
 */
let pool: Pool;
let tenant: string;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  tenant = (await pool.query("INSERT INTO tenants(name) VALUES ('Corridas #699') RETURNING id")).rows[0].id;
});
afterAll(async () => pool.end());

const en = <T,>(f: Parameters<typeof withTenant<T>>[2]) => withTenant(pool, tenant, f);

/**
 * Un modelo de mentira que dice qué herramientas «usó».
 *
 * Va como TERCER ARGUMENTO de `runAgentTask`, no como opción del input. Lo pasé
 * primero dentro del objeto y se ignoró en silencio: la corrida usó el puerto de
 * verdad, falló por falta de llave, y la prueba de «sin herramientas» pasó —el
 * camino de error también escribe `[]`—. Una prueba que pasa por el camino
 * equivocado es peor que una roja.
 */
const modeloQueUsa = (herramientasUsadas?: string[]) => () => ({
  async generate() {
    return {
      text: 'Son 50 UF.',
      tokensIn: 10,
      tokensOut: 5,
      ...(herramientasUsadas ? { herramientasUsadas } : {}),
    };
  },
});

describe('la corrida guarda qué herramientas usó (#699)', () => {
  it('las deja en su columna y listExecutions las devuelve', async () => {
    const agente = await en((c) => createAgent(c, { tenantId: tenant, name: 'Con herramientas' }));
    await en((c) =>
      runAgentTask(c, {
        tenantId: tenant,
        agent: agente,
        task: 'responder',
        prompt: 'cuánto cuesta',
      }, modeloQueUsa(['crm.deals.read', 'knowledge.search'])),
    );
    const corridas = await en((c) => listExecutions(c, tenant, 5));
    expect(corridas[0].herramientas).toEqual(['crm.deals.read', 'knowledge.search']);
  });

  it('una corrida sin herramientas devuelve lista vacía, no null', async () => {
    // La pantalla hace `.length`: un null acá la rompe. El default de la columna ya
    // era `[]` — lo que faltaba era escribirlo y leerlo.
    const agente = await en((c) => createAgent(c, { tenantId: tenant, name: 'Sin herramientas' }));
    await en((c) =>
      runAgentTask(c, {
        tenantId: tenant,
        agent: agente,
        task: 'responder',
        prompt: 'hola',
      }, modeloQueUsa()),
    );
    expect((await en((c) => listExecutions(c, tenant, 1)))[0].herramientas).toEqual([]);
  });

  it('la columna queda escrita de verdad, no solo dentro de output', async () => {
    // Ésta es la propiedad del issue: el dato tenía dos casas y se leía en
    // ninguna. Si vuelve a vivir solo en el jsonb, esto se cae.
    const agente = await en((c) => createAgent(c, { tenantId: tenant, name: 'En su columna' }));
    await en((c) =>
      runAgentTask(c, {
        tenantId: tenant,
        agent: agente,
        task: 'responder',
        prompt: 'precio',
      }, modeloQueUsa(['payments.links.read'])),
    );
    const fila = await pool.query(
      `SELECT tools_called FROM agent_executions
        WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [tenant],
    );
    expect(fila.rows[0].tools_called).toEqual(['payments.links.read']);
  });
});

/**
 * Qué VIO el modelo (#1079).
 *
 * `agent_executions.input` guardaba solo `{ prompt }`, y el prompt es el
 * FORMATO: las reglas no negociables, el JSON de salida, la lista de acciones.
 * Es el mismo texto en cada corrida del mismo tipo de tarea. Lo que cambia —y
 * lo único que explica la respuesta— va en `context`: qué día es, quién es el
 * cliente, el resumen, el trozo de conocimiento y los últimos mensajes.
 *
 * O sea que de las dos mitades se guardaba la que no informa. Es la misma
 * pregunta de #699 y #714 —«¿de dónde sacó eso?»— con la pieza que faltaba:
 * `sources_used` dice de qué documento, pero el conocimiento se recupera por
 * RAG y el nombre del documento no dice qué TROZO se le entregó.
 */
describe('la corrida guarda qué vio el modelo (#1079)', () => {
  it('el contexto queda escrito junto al prompt', async () => {
    const agente = await en((c) => createAgent(c, { tenantId: tenant, name: 'Con contexto' }));
    const contexto = 'Hoy es lunes 26 de octubre de 2026.\nCliente: Ana Pérez (+56912345678).\nUn corte sale $18.000.';
    await en((c) =>
      runAgentTask(
        c,
        { tenantId: tenant, agent: agente, task: 'responder', prompt: 'FORMATO', context: contexto },
        modeloQueUsa(),
      ),
    );

    const fila = await pool.query(
      `SELECT input FROM agent_executions
        WHERE tenant_id = $1 AND agent_id = $2 ORDER BY created_at DESC LIMIT 1`,
      [tenant, agente.id],
    );
    expect(fila.rows[0].input.prompt).toBe('FORMATO');
    expect(fila.rows[0].input.context).toBe(contexto);
    // Lo que de verdad se quiere poder contestar: el precio que dijo, de qué
    // texto salió.
    expect(fila.rows[0].input.context).toContain('$18.000');
  });

  it('una tarea sin contexto no inventa la llave: «no tiene» y «no se le dio» son distintos', async () => {
    const agente = await en((c) => createAgent(c, { tenantId: tenant, name: 'Sin contexto' }));
    await en((c) =>
      runAgentTask(c, { tenantId: tenant, agent: agente, task: 'clasificar', prompt: 'FORMATO' }, modeloQueUsa()),
    );
    const fila = await pool.query(
      `SELECT input FROM agent_executions
        WHERE tenant_id = $1 AND agent_id = $2 ORDER BY created_at DESC LIMIT 1`,
      [tenant, agente.id],
    );
    expect(fila.rows[0].input).toEqual({ prompt: 'FORMATO' });
  });

  it('la conversación queda guardada, que es por donde la purga alcanza la fila', async () => {
    const agente = await en((c) => createAgent(c, { tenantId: tenant, name: 'Con conversación' }));
    const contacto = (
      await pool.query(
        "INSERT INTO contacts (tenant_id, phone, origin) VALUES ($1, '+56987650001', 'whatsapp') RETURNING id",
        [tenant],
      )
    ).rows[0].id;
    const conversacion = (
      await pool.query(
        "INSERT INTO conversations (tenant_id, contact_id, channel) VALUES ($1, $2, 'whatsapp') RETURNING id",
        [tenant, contacto],
      )
    ).rows[0].id;

    await en((c) =>
      runAgentTask(
        c,
        {
          tenantId: tenant,
          agent: agente,
          task: 'responder',
          prompt: 'FORMATO',
          context: 'Cliente: Quien Sea (+56987650001).',
          conversationId: conversacion,
        },
        modeloQueUsa(),
      ),
    );

    const fila = await pool.query(
      `SELECT conversation_id FROM agent_executions
        WHERE tenant_id = $1 AND agent_id = $2 ORDER BY created_at DESC LIMIT 1`,
      [tenant, agente.id],
    );
    expect(fila.rows[0].conversation_id).toBe(conversacion);
  });
});
