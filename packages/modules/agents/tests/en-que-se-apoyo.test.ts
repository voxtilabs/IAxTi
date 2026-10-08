import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createAgent } from '../application/agents';
import { pendingSuggestion } from '../application/copilot';

/**
 * En qué se apoyó la sugerencia (#717).
 *
 * La bandeja mostraba el texto y nada más: una sugerencia respaldada por el
 * conocimiento del negocio y una dicha de memoria se veían **idénticas**. Y quien
 * aprieta «Enviar sugerencia» es quien se hace responsable de lo que sale — darle
 * el texto sin decirle en qué se apoya es pedirle que firme a ciegas.
 *
 * El dato ya estaba: `suggestions.execution_id` apunta a la corrida, y desde #699
 * la corrida guarda `tools_called` de verdad. Faltaba traerlo.
 *
 * La distinción que estas pruebas cuidan es la que importa: **`undefined` no es
 * `[]`**. Lo primero es «no se sabe» —una sugerencia anterior a #699— y lo segundo
 * es «no consultó nada». Mostrar «sin consultar» cuando no se sabe sería afirmar
 * algo que no sabemos, que es justo el defecto que venimos sacando.
 */
let pool: Pool;
let tenant: string;
let agentId: string;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  tenant = (await pool.query("INSERT INTO tenants(name) VALUES ('Apoyo #717') RETURNING id")).rows[0].id;
  agentId = (
    await withTenant(pool, tenant, (c) => createAgent(c, { tenantId: tenant, name: 'Sofía' }))
  ).id;
});
afterAll(async () => pool.end());

/** Una conversación con su sugerencia, y opcionalmente la corrida detrás. */
async function conSugerencia(toolsCalled: string[] | null): Promise<string> {
  const contacto = (
    await pool.query(
      "INSERT INTO contacts (tenant_id, phone, origin) VALUES ($1, $2, 'whatsapp') RETURNING id",
      [tenant, `+5699${Math.floor(Math.random() * 10_000_000)}`],
    )
  ).rows[0].id;
  const conversacion = (
    await pool.query(
      "INSERT INTO conversations (tenant_id, contact_id, channel) VALUES ($1, $2, 'whatsapp') RETURNING id",
      [tenant, contacto],
    )
  ).rows[0].id;

  let ejecucion: string | null = null;
  if (toolsCalled !== null) {
    ejecucion = (
      await pool.query(
        `INSERT INTO agent_executions
           (tenant_id, agent_id, task, provider, model, input, status, trace_id, latency_ms, tools_called)
         VALUES ($1,$2,'sugerir','glm','z-ai/glm-5.3-flash','{}'::jsonb,'ok','t',10,$3) RETURNING id`,
        [tenant, agentId, JSON.stringify(toolsCalled)],
      )
    ).rows[0].id;
  }

  await pool.query(
    `INSERT INTO suggestions
       (tenant_id, agent_id, conversation_id, execution_id, text, status, expires_at)
     VALUES ($1,$2,$3,$4,'Te confirmo el precio.','pending', now() + interval '1 hour')`,
    [tenant, agentId, conversacion, ejecucion],
  );
  return conversacion;
}

describe('la sugerencia dice en qué se apoyó (#717)', () => {
  it('cuando consultó algo, lo trae', async () => {
    const conv = await conSugerencia(['knowledge.search', 'knowledge.get_product']);
    const s = await withTenant(pool, tenant, (c) => pendingSuggestion(c, tenant, conv));
    expect(s?.herramientas).toEqual(['knowledge.search', 'knowledge.get_product']);
  });

  it('cuando NO consultó nada, trae lista vacía — que es un dato, no un vacío', async () => {
    // Responder de memoria a veces está bien: un saludo no necesita el CRM. Lo
    // que no puede pasar es que no se note antes de apretar Enviar.
    const conv = await conSugerencia([]);
    const s = await withTenant(pool, tenant, (c) => pendingSuggestion(c, tenant, conv));
    expect(s?.herramientas).toEqual([]);
  });

  it('una sugerencia sin corrida registrada dice «no se sabe», no «no consultó»', async () => {
    // Ésta es la distinción que importa. Una sugerencia anterior a #699 no tiene
    // nada registrado: mostrarla como «respondió sin consultar nada» sería
    // afirmar algo que no sabemos.
    const conv = await conSugerencia(null);
    const s = await withTenant(pool, tenant, (c) => pendingSuggestion(c, tenant, conv));
    expect(s?.herramientas).toBeUndefined();
    expect(s?.herramientas, 'no se sabe NO es lista vacía').not.toEqual([]);
  });

  it('la sugerencia se muestra igual aunque no se pueda decir en qué se apoyó', async () => {
    // LEFT JOIN y no JOIN: perder la sugerencia por no poder decir su respaldo
    // sería peor que no decirlo.
    const conv = await conSugerencia(null);
    const s = await withTenant(pool, tenant, (c) => pendingSuggestion(c, tenant, conv));
    expect(s?.text).toBe('Te confirmo el precio.');
  });
});
