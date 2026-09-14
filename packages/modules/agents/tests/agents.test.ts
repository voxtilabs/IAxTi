import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { ModuleRegistry } from '@iaxti/core';
import {
  DEFAULT_TASK_MODELS,
  estimateCostUsd,
  iaSettings,
  redactPII,
} from '../domain/config';
import { createAgent, updateAgent } from '../application/agents';
import { allowedToolsFor, listExecutions, runAgentTask } from '../application/runtime';
import type { ModelPortFactory } from '../application/models';
import type { Agent } from '../application/agents';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
let agente: Agent;

// El puerto falso: registra qué le pidieron y responde determinista.
const llamadas: Array<{ provider: string; model: string; system?: string; prompt: string }> = [];
let falla = false;
const fakeFactory: ModelPortFactory = (provider, model) => ({
  async generate(args) {
    llamadas.push({ provider, model, system: args.system, prompt: args.prompt });
    if (falla) throw new Error('el modelo se cayó');
    return { text: `Respuesta simulada para: ${args.prompt.slice(0, 30)}`, tokensIn: 120, tokensOut: 45 };
  },
});

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('agents-test') RETURNING id");
  tenant = t.rows[0].id;
  agente = await withTenant(admin, tenant, (c) =>
    createAgent(c, {
      tenantId: tenant,
      name: 'Sofía',
      personality: 'cálida y directa',
      allowedTools: ['crm.find_contact', 'crm.create_deal', 'tool.inexistente'],
      fallbackSystemPrompt: 'Eres Sofía, asistente de la barbería.',
      actor: 'test',
    }),
  );
});

afterAll(async () => {
  await admin.query('DELETE FROM agent_executions WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM agents WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM usage_meters WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  // audit_log es append-only: el tenant de prueba queda (CI es efímero).
  await admin.end();
});

describe('configuración (dominio, #47)', () => {
  it('proveedor y modelo POR TAREA: el override del tenant manda, sin deploy', () => {
    expect(iaSettings({}).tasks).toEqual(DEFAULT_TASK_MODELS);
    const conOverride = iaSettings({
      ia: { tasks: { sugerir: { provider: 'glm', model: 'glm-4.6' } }, redactPII: false },
    });
    expect(conOverride.tasks.sugerir).toEqual({ provider: 'glm', model: 'glm-4.6' });
    expect(conOverride.tasks.configurar).toEqual(DEFAULT_TASK_MODELS.configurar);
    expect(conOverride.redactPII).toBe(false);
    expect(iaSettings({ ia: { tasks: { sugerir: { provider: 'pirata' } } } }).tasks.sugerir.provider)
      .toBe(DEFAULT_TASK_MODELS.sugerir.provider);
  });

  it('la redacción de PII enmascara teléfono, correo y RUT', () => {
    const texto = 'Llamar a María al +56 9 1234 5678, correo maria@negocio.cl, RUT 11.111.111-1';
    const limpio = redactPII(texto);
    expect(limpio).toContain('[teléfono]');
    expect(limpio).toContain('[correo]');
    expect(limpio).toContain('[rut]');
    expect(limpio).not.toContain('1234');
    expect(limpio).not.toContain('maria@');
  });

  it('el costo se estima por millón de tokens; modelo desconocido da null', () => {
    expect(estimateCostUsd('google', 'gemini-2.5-flash', 1_000_000, 100_000)).toBeCloseTo(0.55, 5);
    expect(estimateCostUsd('otro', 'modelo-x', 1000, 1000)).toBeNull();
  });
});

describe('runtime (#47)', () => {
  it('una corrida deja la Execution COMPLETA y publica agent.executed', async () => {
    const requestId = randomUUID();
    const res = await withTenant(admin, tenant, (c) =>
      runAgentTask(
        c,
        {
          tenantId: tenant,
          agent: agente,
          task: 'sugerir',
          prompt: 'La clienta pregunta por horas para mañana',
          requestId,
        },
        fakeFactory,
      ),
    );
    expect(res.text).toContain('Respuesta simulada');
    expect(res.traceId).toBe(requestId); // MISMO trace desde el request
    expect(res.provider).toBe('google'); // el default por tarea (sugerir)
    expect(res.costUsd).toBeGreaterThan(0);

    const fila = await admin.query('SELECT * FROM agent_executions WHERE id = $1', [res.executionId]);
    expect(fila.rows[0]).toMatchObject({
      task: 'sugerir',
      tokens_in: 120,
      tokens_out: 45,
      trace_id: requestId,
      status: 'ok',
    });
    expect(fila.rows[0].explanation).toContain('sugerir');
    // El system prompt usó el fallback CONFIGURADO (sin Langfuse en test).
    expect(llamadas.at(-1)?.system).toBe('Eres Sofía, asistente de la barbería.');

    const uso = await admin.query(
      `SELECT value FROM usage_meters WHERE tenant_id = $1 AND metric = 'ia_executions'`,
      [tenant],
    );
    expect(Number(uso.rows[0].value)).toBeGreaterThanOrEqual(1);
    const evento = await admin.query(
      `SELECT count(*)::int AS n FROM outbox WHERE name = 'agent.executed' AND tenant_id = $1`,
      [tenant],
    );
    expect(evento.rows[0].n).toBe(1);
  });

  it('el override por tarea del tenant cambia el modelo SIN tocar el agente', async () => {
    await admin.query(
      `UPDATE tenants SET settings = settings ||
        '{"ia":{"tasks":{"clasificar":{"provider":"glm","model":"glm-4.6"}}}}'::jsonb
       WHERE id = $1`,
      [tenant],
    );
    const res = await withTenant(admin, tenant, (c) =>
      runAgentTask(
        c,
        { tenantId: tenant, agent: agente, task: 'clasificar', prompt: '¿quiere cotizar?' },
        fakeFactory,
      ),
    );
    expect(res.provider).toBe('glm');
    expect(res.model).toBe('glm-4.6');
    expect(llamadas.at(-1)).toMatchObject({ provider: 'glm', model: 'glm-4.6' });
    await admin.query(`UPDATE tenants SET settings = '{}'::jsonb WHERE id = $1`, [tenant]);
  });

  it('el fallo queda como Execution failed y publica agent.failed', async () => {
    falla = true;
    const res = await withTenant(admin, tenant, (c) =>
      runAgentTask(
        c,
        { tenantId: tenant, agent: agente, task: 'sugerir', prompt: 'esto va a fallar' },
        fakeFactory,
      ),
    );
    falla = false;
    expect(res.status).toBe('failed');
    expect(res.error).toContain('se cayó');
    const fallada = await admin.query(
      `SELECT status, error FROM agent_executions
        WHERE tenant_id = $1 AND status = 'failed' ORDER BY created_at DESC LIMIT 1`,
      [tenant],
    );
    expect(fallada.rows[0].error).toContain('se cayó');
    const evento = await admin.query(
      `SELECT count(*)::int AS n FROM outbox WHERE name = 'agent.failed' AND tenant_id = $1`,
      [tenant],
    );
    expect(evento.rows[0].n).toBe(1);
  });

  it('las tools permitidas son la intersección con los módulos ACTIVOS', () => {
    const registry = new ModuleRegistry().load();
    const tools = allowedToolsFor(agente, registry);
    expect(tools).toContain('crm.find_contact'); // crm declara y está activo
    expect(tools).not.toContain('tool.inexistente'); // nadie la declara
  });

  it('el listado de consumo trae tokens, costo y trace', async () => {
    const ejecuciones = await withTenant(admin, tenant, (c) => listExecutions(c, tenant));
    expect(ejecuciones.length).toBeGreaterThanOrEqual(3);
    const ok = ejecuciones.find((e) => e.status === 'ok');
    expect(ok?.costUsd).toBeGreaterThan(0);
    expect(ok?.traceId).toBeTruthy();
  });

  it('updateAgent cambia proveedor/modelo con audit; el desconocido se rechaza', async () => {
    const editado = await withTenant(admin, tenant, (c) =>
      updateAgent(c, {
        tenantId: tenant,
        agentId: agente.id,
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        actor: 'test',
      }),
    );
    expect(editado.provider).toBe('anthropic');
    await expect(
      withTenant(admin, tenant, (c) =>
        updateAgent(c, { tenantId: tenant, agentId: agente.id, provider: 'pirata' as never }),
      ),
    ).rejects.toThrow(/desconocido/);
    const audit = await admin.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action = 'agents.update'`,
      [tenant],
    );
    expect(audit.rows[0].n).toBe(1);
  });
});
