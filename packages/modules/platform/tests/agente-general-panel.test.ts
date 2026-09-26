import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations } from '@iaxti/db';
import {
  agenteGeneralApagado,
  apagarAgenteGeneral,
  corridasDelAgenteGeneral,
  encenderAgenteGeneral,
  resumenDelAgenteGeneral,
} from '../application/agente-general-panel';

/**
 * El interruptor del Agente General (#496, ADR-0025).
 *
 * Lo que se prueba es lo que uno querría creer a las 2 de la mañana: que
 * apagarlo apaga de verdad, que el global pesa más que el de un negocio, y
 * que apagar esto NO apaga el resto del producto.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenantA: string;
let tenantB: string;
const superadmin = '00000000-0000-4000-8000-000000000001';

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const a = await admin.query("INSERT INTO tenants (name) VALUES ('ag-panel-a') RETURNING id");
  const b = await admin.query("INSERT INTO tenants (name) VALUES ('ag-panel-b') RETURNING id");
  tenantA = a.rows[0].id;
  tenantB = b.rows[0].id;
});

afterAll(async () => {
  await admin?.end();
});

describe('el interruptor', () => {
  it('arranca encendido', async () => {
    expect((await agenteGeneralApagado(admin, tenantA)).apagado).toBe(false);
  });

  it('apagado por negocio afecta SOLO a ese negocio', async () => {
    await apagarAgenteGeneral(admin, { tenantId: tenantA, motivo: 'propuso algo raro', adminUser: superadmin });
    const a = await agenteGeneralApagado(admin, tenantA);
    expect(a).toMatchObject({ apagado: true, alcance: 'tenant', motivo: 'propuso algo raro' });
    expect((await agenteGeneralApagado(admin, tenantB)).apagado).toBe(false);
  });

  it('exige motivo: sin él nadie sabe después si se puede encender', async () => {
    await expect(
      apagarAgenteGeneral(admin, { tenantId: tenantB, motivo: '   ', adminUser: superadmin }),
    ).rejects.toThrow(/por qué/);
    expect((await agenteGeneralApagado(admin, tenantB)).apagado).toBe(false);
  });

  it('apagarlo dos veces al mismo negocio actualiza el motivo, no duplica', async () => {
    await apagarAgenteGeneral(admin, { tenantId: tenantA, motivo: 'segundo motivo', adminUser: superadmin });
    const filas = await admin.query(
      'SELECT count(*)::int AS n FROM agente_general_apagado WHERE tenant_id = $1',
      [tenantA],
    );
    expect(filas.rows[0].n).toBe(1);
    expect((await agenteGeneralApagado(admin, tenantA)).motivo).toBe('segundo motivo');
  });

  it('el global pesa más: apaga incluso a quien no estaba apagado', async () => {
    await apagarAgenteGeneral(admin, { tenantId: null, motivo: 'mantención', adminUser: superadmin });
    const b = await agenteGeneralApagado(admin, tenantB);
    expect(b).toMatchObject({ apagado: true, alcance: 'global', motivo: 'mantención' });
    // Y en el que YA estaba apagado, el global es el que se reporta: si está
    // apagado para todos, el motivo del negocio no es la explicación.
    expect((await agenteGeneralApagado(admin, tenantA)).alcance).toBe('global');
  });

  it('solo hay UNA fila global, aunque se apague dos veces', async () => {
    await apagarAgenteGeneral(admin, { tenantId: null, motivo: 'otra vez', adminUser: superadmin });
    const filas = await admin.query(
      'SELECT count(*)::int AS n FROM agente_general_apagado WHERE tenant_id IS NULL',
    );
    expect(filas.rows[0].n).toBe(1);
  });

  it('encender el global deja en pie el del negocio', async () => {
    await encenderAgenteGeneral(admin, { tenantId: null, adminUser: superadmin });
    expect((await agenteGeneralApagado(admin, tenantB)).apagado).toBe(false);
    // El de A sigue apagado: encender "para todos" no es perdonar a cada uno.
    expect((await agenteGeneralApagado(admin, tenantA))).toMatchObject({
      apagado: true,
      alcance: 'tenant',
    });
  });

  it('cada movimiento queda en el libro del SuperAdmin', async () => {
    const r = await admin.query(
      `SELECT action, count(*)::int AS n FROM platform_audit
        WHERE action LIKE 'platform.agente_general.%' GROUP BY action ORDER BY action`,
    );
    const acciones = Object.fromEntries(r.rows.map((f) => [f.action, f.n]));
    // Tres apagados exitosos: A, A de nuevo, y el global. El cuarto intento
    // —sin motivo— se rechazó, así que no dejó rastro de apagado.
    expect(acciones['platform.agente_general.apagar']).toBeGreaterThanOrEqual(3);
    expect(acciones['platform.agente_general.encender']).toBeGreaterThanOrEqual(1);
  });
});

describe('lo que se ve del Agente General', () => {
  beforeAll(async () => {
    // Dos corridas suyas (agent_id NULL) y una de un asistente del tenant,
    // que NO tiene que aparecer.
    for (const [tenant, costo, latencia, estado] of [
      [tenantA, 0.002, 1200, 'ok'],
      [tenantB, 0.004, 9000, 'failed'],
    ] as const) {
      await admin.query(
        `INSERT INTO agent_executions
           (tenant_id, agent_id, task, provider, model, input, output, cost_usd, latency_ms, status, trace_id)
         VALUES ($1, NULL, 'configuracion_conversada', 'glm', 'z-ai/glm-5.3', $2, $3, $4, $5, $6, 'tr-1')`,
        [
          tenant,
          JSON.stringify({ turnos: 2, ultima: 'quiero atender los sábados' }),
          JSON.stringify({ text: 'listo', pasos: ['agenda.disponibilidad'] }),
          costo,
          latencia,
          estado,
        ],
      );
    }
    const agente = await admin.query(
      `INSERT INTO agents (tenant_id, name, provider, model) VALUES ($1, 'del tenant', 'glm', 'z-ai/glm-5.3') RETURNING id`,
      [tenantA],
    );
    await admin.query(
      `INSERT INTO agent_executions (tenant_id, agent_id, task, provider, model, input, status)
       VALUES ($1, $2, 'sugerir', 'glm', 'z-ai/glm-5.3-flash', '{}'::jsonb, 'ok')`,
      [tenantA, agente.rows[0].id],
    );
  });

  it('solo sus corridas, no las de los asistentes del tenant', async () => {
    // Por negocio y no global: la base de pruebas es compartida y otras
    // suites dejan corridas suyas. Contar el total haría que este test
    // fallara por lo que hizo otro archivo.
    const deA = await corridasDelAgenteGeneral(admin, { tenantId: tenantA });
    expect(deA).toHaveLength(1);
    expect(deA[0].herramientas).toEqual(['agenda.disponibilidad']);
    // Trae el nombre del negocio: un uuid en el panel no le dice nada a nadie.
    expect(deA[0].tenant).toMatch(/ag-panel/);
    expect(deA[0].pidio).toContain('sábados');
  });

  it('se puede mirar un negocio solo', async () => {
    const corridas = await corridasDelAgenteGeneral(admin, { tenantId: tenantB });
    expect(corridas).toHaveLength(1);
    expect(corridas[0].status).toBe('failed');
  });

  it('el resumen cuenta el costo, los errores y el p95', async () => {
    const deB = await resumenDelAgenteGeneral(admin, { tenantId: tenantB });
    expect(deB.corridasDelMes).toBe(1);
    expect(deB.costoDelMesUsd).toBeCloseTo(0.004, 4);
    // La de B falló: la tasa de error de ese negocio es 1.
    expect(deB.tasaDeError).toBeCloseTo(1, 2);
    expect(deB.negocios).toBe(1);
    // El p95 y no el promedio: el promedio esconde justo la cola que molesta.
    expect(deB.latenciaP95Ms).toBe(9000);
  });

  it('el resumen global suma a todos los negocios', async () => {
    const todos = await resumenDelAgenteGeneral(admin);
    const deA = await resumenDelAgenteGeneral(admin, { tenantId: tenantA });
    expect(todos.corridasDelMes).toBeGreaterThanOrEqual(deA.corridasDelMes + 1);
    expect(todos.negocios).toBeGreaterThanOrEqual(2);
  });

  it('sin corridas la tasa de error es 0, no NaN', async () => {
    // Un tablero que muestra NaN se lee como que el tablero está roto.
    const vacio = await createPool(ADMIN_URL);
    try {
      await vacio.query('CREATE TEMP TABLE no_usada (x int)');
      const r = await resumenDelAgenteGeneral({
        query: async (sql: string, params?: unknown[]) =>
          sql.includes('count(*)::int AS corridas')
            ? { rows: [{ corridas: 0, costo: 0, fallidas: 0, negocios: 0, p95: null }], rowCount: 1 }
            : vacio.query(sql, params as never),
      } as never);
      expect(r.tasaDeError).toBe(0);
      expect(r.latenciaP95Ms).toBeNull();
    } finally {
      await vacio.end();
    }
  });
});
