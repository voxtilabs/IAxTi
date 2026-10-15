import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations } from '@iaxti/db';
import { aiExecutions, aiMetrics, alertasCosto, promptsActivos, traceUrl } from '../application/centro-ia';

// Centro de IA (#70): el costo por modelo y por tenant es lo que dice si el
// ahorro de cambiar de modelo es real.

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
let agente: string;

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query(
    "INSERT INTO tenants (name, plan) VALUES ('centro-ia', 'base') RETURNING id",
  );
  tenant = t.rows[0].id;
  const a = await admin.query(
    // Proveedor y modelo EXPLÍCITOS desde #861: la columna ya no tiene valor
    // por defecto, porque el que tenía nombraba un modelo retirado.
    `INSERT INTO agents (tenant_id, name, prompt_name, prompt_version, provider, model)
     VALUES ($1, 'Copiloto', 'copiloto-sugerencia', '3', 'openai', 'gpt-5-mini') RETURNING id`,
    [tenant],
  );
  agente = a.rows[0].id;

  // Dos modelos, para que el contraste de costo se vea: el caro responde
  // rápido, el barato es más lento y falla una vez.
  const filas: Array<[string, string, number, number, number, string]> = [
    ['google', 'gemini-2.5-flash', 0.004, 900, 1, 'ok'],
    ['google', 'gemini-2.5-flash', 0.006, 1100, 1, 'ok'],
    ['zhipu', 'glm-4-flash', 0.0004, 2600, 1, 'ok'],
    ['zhipu', 'glm-4-flash', 0.0004, 3000, 1, 'failed'],
  ];
  for (const [provider, model, costo, latencia, , status] of filas) {
    await admin.query(
      `INSERT INTO agent_executions
         (tenant_id, agent_id, task, provider, model, input, tokens_in, tokens_out,
          cost_usd, latency_ms, trace_id, status)
       VALUES ($1, $2, 'sugerir', $3, $4, $5::jsonb, 100, 50, $6, $7, 'trace-abc', $8)`,
      [tenant, agente, provider, model, JSON.stringify({ conversationId: 'conv-1' }), costo, latencia, status],
    );
  }
});

afterAll(async () => {
  await admin.query('DELETE FROM agent_executions WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM agents WHERE tenant_id = $1', [tenant]);
  await admin.end();
});

describe('métricas (#70)', () => {
  it('agrupa por modelo con costo en pesos, éxito y p95', async () => {
    const filas = await aiMetrics(admin, { tenantId: tenant, groupBy: 'modelo', usdClp: 950 });
    const gemini = filas.find((f) => f.clave === 'google/gemini-2.5-flash')!;
    const glm = filas.find((f) => f.clave === 'zhipu/glm-4-flash')!;

    expect(gemini.ejecuciones).toBe(2);
    expect(gemini.costUsd).toBeCloseTo(0.01, 6);
    // El costo en pesos usa el tipo de cambio que entrega quien llama.
    expect(gemini.costClp).toBe(Math.round(0.01 * 950));
    expect(gemini.exitoPct).toBe(100);

    // El barato cuesta un orden de magnitud menos: eso es lo que se compara.
    expect(glm.costUsd).toBeLessThan(gemini.costUsd);
    // …y falla una de dos, que es justo lo que el promedio escondería.
    expect(glm.exitoPct).toBe(50);
    expect(glm.latenciaP95).toBeGreaterThan(gemini.latenciaP95!);
  });

  it('agrupa por tarea y por agente sin inventar claves vacías', async () => {
    const porTarea = await aiMetrics(admin, { tenantId: tenant, groupBy: 'tarea' });
    expect(porTarea).toHaveLength(1);
    expect(porTarea[0].clave).toBe('sugerir');
    expect(porTarea[0].ejecuciones).toBe(4);

    /**
     * El cruce tarea × proveedor, que es el que contesta qué cambiar (#858).
     *
     * «Por tarea» dice que `sugerir` tarda; no dice con cuál proveedor, que
     * es lo único que se puede mover. Acá las cuatro corridas son de la misma
     * tarea y de dos proveedores: google responde en ~1 s y zhipu en ~2,8 s.
     * Agrupadas por tarea serían una fila con la latencia promediada entre
     * los dos —la lectura que esconde el problema—; separadas, se ve cuál es.
     *
     * Es la medición que el 12-10 movió el defecto del producto entero, y
     * para tenerla hubo que medir a mano contra las dos cuentas.
     */
    const cruce = await aiMetrics(admin, { tenantId: tenant, groupBy: 'tarea-proveedor' });
    expect(cruce).toHaveLength(2);
    const claves = cruce.map((f) => f.clave).sort();
    expect(claves).toEqual(['sugerir · google', 'sugerir · zhipu']);
    const google = cruce.find((f) => f.clave === 'sugerir · google')!;
    const zhipu = cruce.find((f) => f.clave === 'sugerir · zhipu')!;
    expect(google.latenciaP50).toBeLessThan(zhipu.latenciaP50!);
    // Y el costo va al lado, que es el otro medio dato: el lento es el barato.
    expect(google.costUsd).toBeGreaterThan(zhipu.costUsd);

    const porAgente = await aiMetrics(admin, { tenantId: tenant, groupBy: 'agente' });
    expect(porAgente[0].clave).toBe(agente);
  });
});

describe('navegación al trace (#70)', () => {
  it('sin Langfuse configurado no inventa una URL', () => {
    expect(traceUrl('trace-abc', {} as NodeJS.ProcessEnv)).toBeNull();
    expect(traceUrl(null, { LANGFUSE_BASE_URL: 'https://lf.test' } as NodeJS.ProcessEnv)).toBeNull();
    expect(traceUrl('trace-abc', { LANGFUSE_BASE_URL: 'https://lf.test/' } as NodeJS.ProcessEnv)).toBe(
      'https://lf.test/trace/trace-abc',
    );
    expect(
      traceUrl('trace-abc', {
        LANGFUSE_BASE_URL: 'https://lf.test',
        LANGFUSE_PROJECT_ID: 'p1',
      } as NodeJS.ProcessEnv),
    ).toBe('https://lf.test/project/p1/traces/trace-abc');
  });

  it('la ejecución trae el camino completo: conversación, trace y estado', async () => {
    const ejecuciones = await aiExecutions(admin, { tenantId: tenant, limit: 10 });
    expect(ejecuciones).toHaveLength(4);
    expect(ejecuciones[0].conversationId).toBe('conv-1');
    expect(ejecuciones[0].traceId).toBe('trace-abc');

    const fallidas = await aiExecutions(admin, { tenantId: tenant, soloFallidas: true });
    expect(fallidas).toHaveLength(1);
    expect(fallidas[0].status).toBe('failed');

    const porModelo = await aiExecutions(admin, { tenantId: tenant, model: 'zhipu/glm-4-flash' });
    expect(porModelo).toHaveLength(2);
  });
});

describe('prompts y alertas (#70)', () => {
  it('muestra qué prompt está vivo en cada agente', async () => {
    const prompts = await promptsActivos(admin, tenant);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({
      nombre: 'Copiloto',
      promptName: 'copiloto-sugerencia',
      promptVersion: '3',
    });
  });

  it('sin presupuesto declarado informa el gasto y no inventa un porcentaje', async () => {
    await admin.query('UPDATE plan_limits SET ia_budget_usd = NULL WHERE plan = $1', ['base']);
    const sinTope = (await alertasCosto(admin, { usdClp: 950 })).find((a) => a.tenantId === tenant)!;
    expect(sinTope.costUsdCiclo).toBeGreaterThan(0);
    expect(sinTope.presupuestoUsd).toBeNull();
    expect(sinTope.pct).toBeNull();
    expect(sinTope.nivel).toBe('ok');

    // Con tope, el nivel sale de comparar contra ese número y no otro.
    await admin.query('UPDATE plan_limits SET ia_budget_usd = 0.01 WHERE plan = $1', ['base']);
    const conTope = (await alertasCosto(admin, { usdClp: 950 })).find((a) => a.tenantId === tenant)!;
    expect(conTope.presupuestoUsd).toBe(0.01);
    expect(conTope.nivel).toBe('excedido');
    await admin.query('UPDATE plan_limits SET ia_budget_usd = NULL WHERE plan = $1', ['base']);
  });
});
