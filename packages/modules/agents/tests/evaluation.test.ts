import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { receiveInbound } from '@iaxti/module-conversations';
import { formatoJuez, parseJudge } from '../domain/judge';
import {
  evalGate,
  harvestFeedbackCases,
  latestScoreFor,
  listEvalCases,
  runEvaluation,
} from '../application/evaluation';
import { createAgent } from '../application/agents';
import { suggestForInbound, feedbackSuggestion } from '../application/copilot';
import type { Agent } from '../application/agents';
import type { ModelPortFactory } from '../application/models';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
let agent: Agent;
let conversacion: string;

const JSON_SUGERENCIA = `{"sugerencia": "¡Hola! Tenemos horas mañana a las 10:00 — ¿te acomoda?",
"confianza": 0.9, "intencion": "agendar", "calificacion": "caliente", "crear_oportunidad": false}`;

const candidatoFake: ModelPortFactory = () => ({
  async generate() {
    return { text: JSON_SUGERENCIA, tokensIn: 100, tokensOut: 40 };
  },
});

function juezFijo(nota: number): ModelPortFactory {
  return () => ({
    async generate() {
      return {
        text: `{"correctness": ${nota}, "tono": ${nota}, "tools": ${nota}, "comentario": "ok"}`,
        tokensIn: 50,
        tokensOut: 20,
      };
    },
  });
}

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('evals-test') RETURNING id");
  tenant = t.rows[0].id;
  agent = await withTenant(admin, tenant, (c) =>
    createAgent(c, { tenantId: tenant, name: 'Sofía', fallbackSystemPrompt: 'Eres Sofía.', actor: 'test' }),
  );
  const res = await withTenant(admin, tenant, (c) =>
    receiveInbound(c, {
      tenantId: tenant,
      phone: '+56966660001',
      channel: 'simulador',
      body: 'Hola, soy Marcela, mi correo es marcela@gmail.com. ¿Tienen horas?',
    }),
  );
  conversacion = res.conversation.id;
  // Una sugerencia con 👎 y motivo: la semilla del dataset.
  const sug = await withTenant(admin, tenant, (c) =>
    suggestForInbound(c, { tenantId: tenant, conversationId: conversacion }, candidatoFake),
  );
  await withTenant(admin, tenant, (c) =>
    feedbackSuggestion(c, {
      tenantId: tenant,
      suggestionId: sug!.id,
      feedback: 'down',
      reason: 'ofreció una hora sin revisar la agenda',
    }),
  );
});

afterAll(async () => {
  for (const tabla of ['eval_runs', 'eval_cases', 'suggestions', 'agent_executions', 'agents', 'usage_meters', 'assignments', 'messages', 'conversations', 'contacts', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.end();
});

describe('el juez (#53)', () => {
  it('la rúbrica pesa correctness doble y la basura reprueba', () => {
    const notas = parseJudge('{"correctness": 1, "tono": 0.5, "tools": 0.5}');
    expect(notas.total).toBe(0.75); // (2 + 0.5 + 0.5) / 4
    const ilegible = parseJudge('el asistente estuvo bien');
    expect(ilegible.total).toBe(0);
    // …y el 0 viene marcado como NO medible: "no se pudo leer" no es "salió pésimo".
    expect(ilegible.medible).toBe(false);
    expect(parseJudge('{"correctness": 1, "tono": 1, "tools": 1}').medible).toBe(true);
    // El caso real que lo destapó: el juez cortado a la mitad.
    expect(parseJudge('{"correctness": 0.8').medible).toBe(false);
    expect(formatoJuez({ contexto: 'x', criterios: ['no inventa'], respuesta: 'y' })).toContain('no inventa');
  });

  it('el dataset del repo está completo y versionado', () => {
    const dataset = JSON.parse(
      readFileSync(join(__dirname, '..', 'evals', 'dataset-sugerir.json'), 'utf8'),
    );
    expect(dataset.version).toBe(1);
    expect(dataset.casos.length).toBeGreaterThanOrEqual(5);
    for (const caso of dataset.casos) {
      expect(caso.criterios.length).toBeGreaterThan(0);
      expect(JSON.stringify(caso)).not.toMatch(/\+569\d{8}/); // anonimizado
    }
    const baseline = JSON.parse(readFileSync(join(__dirname, '..', 'evals', 'baseline.json'), 'utf8'));
    expect(baseline.sugerir).toBeGreaterThan(0);
  });
});

describe('dataset del tenant y el gate (#53)', () => {
  it('el pulgar de la bandeja se vuelve caso ANONIMIZADO, una sola vez', async () => {
    const creados = await withTenant(admin, tenant, (c) => harvestFeedbackCases(c, tenant));
    expect(creados).toBe(1);
    expect(await withTenant(admin, tenant, (c) => harvestFeedbackCases(c, tenant))).toBe(0); // idempotente

    const casos = await withTenant(admin, tenant, (c) => listEvalCases(c, tenant));
    expect(casos).toHaveLength(1);
    expect(casos[0].criterios[0]).toContain('sin revisar la agenda');
    // PII fuera: ni el teléfono ni el correo sobreviven.
    expect(casos[0].contexto).not.toContain('66660001');
    expect(casos[0].contexto).not.toContain('marcela@gmail.com');
  });

  it('correr la evaluación guarda el run con el score del juez', async () => {
    const casos = await withTenant(admin, tenant, (c) => listEvalCases(c, tenant));
    const run = await withTenant(admin, tenant, (c) =>
      runEvaluation(c, { tenantId: tenant, agent, cases: casos }, candidatoFake, juezFijo(0.8)),
    );
    expect(run.score).toBe(0.8);
    expect(run.caseCount).toBe(1);
    expect(run.scores[0].respuesta).toContain('¿te acomoda?');
    expect(
      await withTenant(admin, tenant, (c) =>
        latestScoreFor(c, tenant, agent.id, {
          provider: agent.provider,
          model: agent.model,
          promptVersion: agent.promptVersion,
        }),
      ),
    ).toBe(0.8);
  });

  it('el gate bloquea la config con score menor y deja pasar la mejor', async () => {
    const casos = await withTenant(admin, tenant, (c) => listEvalCases(c, tenant));
    // La config candidata (glm) evaluada peor:
    const peor = { ...agent, provider: 'glm' as const, model: 'glm-4.6' };
    await withTenant(admin, tenant, (c) =>
      runEvaluation(c, { tenantId: tenant, agent: peor, cases: casos }, candidatoFake, juezFijo(0.5)),
    );
    const bloqueado = await withTenant(admin, tenant, (c) =>
      evalGate(c, tenant, agent, { provider: 'glm', model: 'glm-4.6', promptVersion: agent.promptVersion }),
    );
    expect(bloqueado).toEqual({ allowed: false, actual: 0.8, candidata: 0.5 });

    // Otra corrida de la candidata que la deja mejor: pasa.
    await withTenant(admin, tenant, (c) =>
      runEvaluation(c, { tenantId: tenant, agent: peor, cases: casos }, candidatoFake, juezFijo(0.9)),
    );
    const permitido = await withTenant(admin, tenant, (c) =>
      evalGate(c, tenant, agent, { provider: 'glm', model: 'glm-4.6', promptVersion: agent.promptVersion }),
    );
    expect(permitido.allowed).toBe(true);

    // Sin evidencia de la candidata: pasa (no hay con qué comparar).
    const sinDatos = await withTenant(admin, tenant, (c) =>
      evalGate(c, tenant, agent, { provider: 'anthropic', model: 'claude-sonnet-5', promptVersion: null }),
    );
    expect(sinDatos.allowed).toBe(true);
    expect(sinDatos.candidata).toBeNull();
  });
});

describe('una respuesta cortada no es una nota de cero (#53)', () => {
  const CASOS = [
    { id: 'c1', contexto: 'El cliente pregunta el precio.', criterios: ['no inventa precio'] },
    { id: 'c2', contexto: 'El cliente pide hora.', criterios: ['ofrece agendar'] },
  ];
  const cortado: ModelPortFactory = () => ({
    async generate() {
      return { text: '{"sugerencia": "¡Hola! Para darte el valor exa', tokensIn: 100, tokensOut: 1024, truncada: true };
    },
  });

  it('si al candidato lo cortan, no se paga el juez ni se inventa un cero', async () => {
    let juecesLlamados = 0;
    const juezContador: ModelPortFactory = () => ({
      async generate() {
        juecesLlamados += 1;
        return { text: '{"correctness": 1, "tono": 1, "tools": 1}', tokensIn: 10, tokensOut: 10 };
      },
    });
    const config = { ...agent, provider: 'anthropic' as const, model: 'cortado-1' };
    await expect(
      withTenant(admin, tenant, (c) =>
        runEvaluation(c, { tenantId: tenant, agent: config, cases: CASOS }, cortado, juezContador),
      ),
    ).rejects.toThrow(/no hay medición/);
    // Ni una llamada al juez: juzgar media frase cuesta plata y no mide nada.
    expect(juecesLlamados).toBe(0);
    // Y NADA quedó guardado: un run sin notas no es un score de 0.
    expect(
      await withTenant(admin, tenant, (c) =>
        latestScoreFor(c, tenant, agent.id, { provider: 'anthropic', model: 'cortado-1' }),
      ),
    ).toBeNull();
  });

  it('el juez cortado tampoco cuenta como cero', async () => {
    const juezCortado: ModelPortFactory = () => ({
      async generate() {
        return { text: '{"correctness": 0.8', tokensIn: 10, tokensOut: 1024, truncada: true };
      },
    });
    const config = { ...agent, provider: 'anthropic' as const, model: 'cortado-2' };
    await expect(
      withTenant(admin, tenant, (c) =>
        runEvaluation(c, { tenantId: tenant, agent: config, cases: CASOS }, candidatoFake, juezCortado),
      ),
    ).rejects.toThrow(/no hay medición/);
  });

  it('con un caso medible y otro cortado, el promedio sale SOLO del medible', async () => {
    let llamada = 0;
    const unoSeCorta: ModelPortFactory = () => ({
      async generate() {
        llamada += 1;
        return llamada === 1
          ? { text: '{"sugerencia": "medio corta', tokensIn: 100, tokensOut: 1024, truncada: true }
          : { text: JSON_SUGERENCIA, tokensIn: 100, tokensOut: 40 };
      },
    });
    const config = { ...agent, provider: 'anthropic' as const, model: 'mixto' };
    const run = await withTenant(admin, tenant, (c) =>
      runEvaluation(c, { tenantId: tenant, agent: config, cases: CASOS }, unoSeCorta, juezFijo(0.8)),
    );
    // Antes: (0 + 0.8) / 2 = 0.4 — un score hundido por un problema de tokens.
    expect(run.score).toBe(0.8);
    expect(run.caseCount).toBe(2);
    expect(run.casesMedidos).toBe(1);
    expect(run.scores.filter((s) => !s.medible)).toHaveLength(1);
  });

  it('el gate deja de aprobar cualquier cosa por culpa de un run cortado', async () => {
    // El escenario que rompía en silencio: el run de la config VIGENTE se
    // corta, su score queda en 0, y entonces `candidata >= actual` se cumple
    // solo. El gate aprobaba una versión peor sin decir nada.
    const vigente = { ...agent, provider: 'anthropic' as const, model: 'vigente' };
    await expect(
      withTenant(admin, tenant, (c) =>
        runEvaluation(c, { tenantId: tenant, agent: vigente, cases: CASOS }, cortado, juezFijo(0.9)),
      ),
    ).rejects.toThrow();

    // Sin score fabricado, el gate dice la verdad: no hay con qué comparar.
    const g = await withTenant(admin, tenant, (c) =>
      evalGate(c, tenant, vigente, { provider: 'glm', model: 'glm-4.6', promptVersion: vigente.promptVersion }),
    );
    expect(g.actual).toBeNull();
  });
});
