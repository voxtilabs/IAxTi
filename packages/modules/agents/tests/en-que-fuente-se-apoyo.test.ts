import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createAgent } from '../application/agents';
import { pendingSuggestion } from '../application/copilot';

/**
 * En qué FUENTE del conocimiento se apoyó la sugerencia (#714).
 *
 * #699 hizo que la corrida registrara qué herramientas consultó y #717 lo llevó
 * a la bandeja. Esta es la otra mitad, y es la que el negocio pregunta más
 * seguido: cuando un cliente reclama que le dijeron un precio, lo que uno
 * necesita saber es **de qué documento salió ese precio**.
 *
 * La distinción es la misma de #717 y por la misma razón: **NULL no es `[]`**.
 * NULL es «no se sabe» —una corrida de antes de este cambio, o una tarea que no
 * consulta conocimiento— y `[]` es «lo dijo sin apoyarse en ninguna fuente».
 * Decir lo segundo cuando pasa lo primero es afirmar algo que no sabemos.
 *
 * Y por eso `sources_used` nace nullable SIN default, al contrario de
 * `tools_called`: esa nació con `DEFAULT '[]'` y durante meses dijo «no consultó
 * nada» en corridas donde nadie estaba guardando el dato.
 */
let pool: Pool;
let tenant: string;
let agentId: string;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  tenant = (await pool.query("INSERT INTO tenants(name) VALUES ('Fuente #714') RETURNING id")).rows[0]
    .id;
  agentId = (
    await withTenant(pool, tenant, (c) => createAgent(c, { tenantId: tenant, name: 'Sofía' }))
  ).id;
});
afterAll(async () => pool.end());

/** Una conversación con su sugerencia y la corrida detrás. */
async function conSugerencia(
  fuentes: Array<{ id: string; nombre: string }> | null,
): Promise<string> {
  const contacto = (
    await pool.query(
      "INSERT INTO contacts (tenant_id, phone, origin) VALUES ($1, $2, 'whatsapp') RETURNING id",
      [tenant, `+5698${Math.floor(Math.random() * 10_000_000)}`],
    )
  ).rows[0].id;
  const conversacion = (
    await pool.query(
      "INSERT INTO conversations (tenant_id, contact_id, channel) VALUES ($1, $2, 'whatsapp') RETURNING id",
      [tenant, contacto],
    )
  ).rows[0].id;
  const ejecucion = (
    await pool.query(
      `INSERT INTO agent_executions
         (tenant_id, agent_id, task, provider, model, input, status, trace_id, latency_ms, sources_used)
       VALUES ($1,$2,'sugerir','glm','z-ai/glm-5.3-flash','{}'::jsonb,'ok','t',10,$3) RETURNING id`,
      [tenant, agentId, fuentes === null ? null : JSON.stringify(fuentes)],
    )
  ).rows[0].id;
  await pool.query(
    `INSERT INTO suggestions
       (tenant_id, agent_id, conversation_id, execution_id, text, status, expires_at)
     VALUES ($1,$2,$3,$4,'La manicure cuesta 15.000.','pending', now() + interval '1 hour')`,
    [tenant, agentId, conversacion, ejecucion],
  );
  return conversacion;
}

describe('la sugerencia dice de qué fuente lo sacó (#714)', () => {
  it('cuando se apoyó en una fuente, la trae con su nombre', async () => {
    const conv = await conSugerencia([{ id: 'f1', nombre: 'Lista de precios' }]);
    const s = await withTenant(pool, tenant, (c) => pendingSuggestion(c, tenant, conv));
    expect(s?.fuentes).toEqual([{ id: 'f1', nombre: 'Lista de precios' }]);
  });

  it('el nombre viene GUARDADO: la fuente ya no tiene que existir', async () => {
    // El acta de ese momento. Si la fuente se renombró o se sacó del
    // conocimiento, un join devolvería nada y la pantalla no podría decir de
    // dónde salió lo que se le dijo al cliente — que es justo cuando se
    // pregunta. El id va igual, para abrirla mientras todavía está.
    const conv = await conSugerencia([{ id: '00000000-0000-0000-0000-000000000000', nombre: 'Precios de marzo' }]);
    const s = await withTenant(pool, tenant, (c) => pendingSuggestion(c, tenant, conv));
    expect(s?.fuentes?.[0].nombre).toBe('Precios de marzo');
  });

  it('cuando consultó y no encontró nada, trae lista VACÍA', async () => {
    // Eso se puede afirmar y hay que afirmarlo: «esto lo dijo sin consultar el
    // conocimiento del negocio» es lo que quien aprieta Enviar necesita leer.
    const conv = await conSugerencia([]);
    const s = await withTenant(pool, tenant, (c) => pendingSuggestion(c, tenant, conv));
    expect(s?.fuentes).toEqual([]);
  });

  it('sin el dato registrado dice «no se sabe», no «sin consultar»', async () => {
    const conv = await conSugerencia(null);
    const s = await withTenant(pool, tenant, (c) => pendingSuggestion(c, tenant, conv));
    expect(s?.fuentes).toBeUndefined();
    expect(s?.fuentes, 'no se sabe NO es lista vacía').not.toEqual([]);
  });

  it('y la sugerencia se muestra igual', async () => {
    const conv = await conSugerencia(null);
    const s = await withTenant(pool, tenant, (c) => pendingSuggestion(c, tenant, conv));
    expect(s?.text).toBe('La manicure cuesta 15.000.');
  });
});
