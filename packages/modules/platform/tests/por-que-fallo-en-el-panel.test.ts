import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations } from '@iaxti/db';
import { aiExecutions } from '../application/centro-ia';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

/**
 * El panel de ejecuciones de IA dice POR QUÉ falló (#866).
 *
 * Lo que costó: el dueño miró su propio listado el 12-10 y encontró 51 corridas
 * entre el 23-09 y el 09-10, **todas fallidas, ninguna exitosa**. Tres semanas
 * de IA que nunca funcionó, y el panel que existe para verlo decía «falló»
 * cincuenta y una veces. El motivo estaba en la misma fila: la columna `error`
 * se escribe en cada fallo y la consulta no la seleccionaba.
 *
 * Las dos causas reales de ese período eran distinguibles —y él las dedujo
 * así— por la LATENCIA: 0 ms es una llamada que no se hizo porque no había
 * llave; 1200 ms es una que salió a la red y volvió con error de saldo. Tener
 * que inferir la causa de la duración es la definición de un panel que no
 * diagnostica.
 *
 * Esta prueba usa esas dos filas exactas.
 */
let admin: Pool;
let tenant: string;

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  tenant = (
    await admin.query("INSERT INTO tenants (name, plan) VALUES ('por-que-fallo', 'base') RETURNING id")
  ).rows[0].id;
  const a = await admin.query(
    `INSERT INTO agents (tenant_id, name, provider, model) VALUES ($1, 'Copiloto', 'openai', 'gpt-5-mini') RETURNING id`,
    [tenant],
  );
  const agente = a.rows[0].id;

  // Las dos fallas del caso real, con su latencia característica.
  const filas: Array<[string, string, number, string, string, boolean]> = [
    // 0 ms: nunca salió a la red. No había llave (#853).
    ['glm', 'z-ai/glm-5.3-flash', 0, 'failed', 'glm no tiene credencial configurada (GLM_API_KEY)', true],
    // 1200 ms: salió, volvió con error de facturación.
    ['google', 'gemini-flash-latest', 1200, 'failed', '429 RESOURCE_EXHAUSTED · prepayment credits are depleted', true],
    // Y una que sí anduvo, para que el panel distinga.
    ['openai', 'gpt-5-mini', 4300, 'ok', '', false],
  ];
  for (const [provider, model, latencia, status, error, delProveedor] of filas) {
    await admin.query(
      `INSERT INTO agent_executions
         (tenant_id, agent_id, task, provider, model, input, tokens_in, tokens_out,
          cost_usd, latency_ms, trace_id, status, error, error_del_proveedor)
       VALUES ($1,$2,'sugerir',$3,$4,$5::jsonb,100,50,0.001,$6,'trace-xyz',$7,$8,$9)`,
      [
        tenant,
        agente,
        provider,
        model,
        JSON.stringify({ conversationId: 'conv-1' }),
        latencia,
        status,
        error || null,
        delProveedor,
      ],
    );
  }
});

afterAll(async () => admin.end());

describe('el listado de ejecuciones dice por qué falló (#866)', () => {
  it('trae el motivo de cada falla, no solo el estado', async () => {
    const filas = await aiExecutions(admin, { tenantId: tenant });
    // Anti-vacuidad: si la siembra fallara, lo de abajo no mediría nada.
    expect(filas).toHaveLength(3);

    const sinLlave = filas.find((f) => f.provider === 'glm')!;
    const sinSaldo = filas.find((f) => f.provider === 'google')!;

    // Lo que el panel no podía decir: las dos fallan, y por razones distintas.
    expect(sinLlave.status).toBe('failed');
    expect(sinSaldo.status).toBe('failed');
    expect(sinLlave.error).toContain('GLM_API_KEY');
    expect(sinSaldo.error).toContain('credits are depleted');
    // Y no son el mismo texto: si la consulta trajera una constante o un null
    // en vez de la columna, esto pasaría igual sin esta línea.
    expect(sinLlave.error).not.toBe(sinSaldo.error);
  });

  it('distingue lo que es del proveedor de lo que es nuestro', async () => {
    const filas = await aiExecutions(admin, { tenantId: tenant });
    expect(filas.find((f) => f.provider === 'glm')!.errorDelProveedor).toBe(true);
    expect(filas.find((f) => f.provider === 'google')!.errorDelProveedor).toBe(true);
    // La que anduvo no tiene nada que contar, y eso también se ve.
    const ok = filas.find((f) => f.status === 'ok')!;
    expect(ok.error).toBeNull();
    expect(ok.errorDelProveedor).toBe(false);
  });

  it('la latencia deja de ser la única pista: 0 ms y 1200 ms traen su propio motivo', async () => {
    const filas = await aiExecutions(admin, { tenantId: tenant });
    const sinLlave = filas.find((f) => f.latencyMs === 0)!;
    const sinSaldo = filas.find((f) => f.latencyMs === 1200)!;
    // Esto es el caso real: 0 ms nunca llamó, 1200 ms llamó y le dijeron no.
    expect(sinLlave.error).toBeTruthy();
    expect(sinSaldo.error).toBeTruthy();
    expect(sinLlave.error).not.toBe(sinSaldo.error);
  });

  it('el filtro de solo-fallidas sigue trayendo el motivo', async () => {
    const filas = await aiExecutions(admin, { tenantId: tenant, soloFallidas: true });
    expect(filas).toHaveLength(2);
    for (const f of filas) {
      expect(f.error, `la falla de ${f.provider} llegó sin motivo`).toBeTruthy();
    }
  });
});
