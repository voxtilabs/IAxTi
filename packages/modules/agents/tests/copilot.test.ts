import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { getContext, receiveInbound } from '@iaxti/module-conversations';
import { FORMATO_SUGERENCIA, parseSuggestion } from '../domain/parser';
import {
  conversationAnalysis,
  feedbackSuggestion,
  pendingSuggestion,
  resolveSuggestion,
  suggestForInbound,
  transcribeInboundAudio,
} from '../application/copilot';
import { createAgent } from '../application/agents';
import type { ModelPortFactory } from '../application/models';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
let conversacion: string;
let mensajeAudio: string;

const JSON_SUGERENCIA = `{"sugerencia": "¡Hola María! Tenemos horas mañana a las 10:00 y a las 16:00 — ¿cuál te acomoda?",
"confianza": 0.86, "intencion": "agendar", "calificacion": "caliente", "crear_oportunidad": true}`;

// Por prompt: resumir devuelve texto plano; sugerir devuelve el JSON.
const fakeFactory: ModelPortFactory = () => ({
  async generate(args) {
    const esResumen = args.prompt.startsWith('Resume');
    return {
      text: esResumen
        ? 'María pregunta por horas para manicure; prefiere las mañanas; ya vino en agosto.'
        : JSON_SUGERENCIA,
      tokensIn: 200,
      tokensOut: 60,
    };
  },
});

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('copilot-test') RETURNING id");
  tenant = t.rows[0].id;
  await withTenant(admin, tenant, (c) =>
    createAgent(c, { tenantId: tenant, name: 'Sofía', fallbackSystemPrompt: 'Eres Sofía.', actor: 'test' }),
  );
  // 10 mensajes: la ventana es 8 → quedan 2 viejos por resumir.
  for (let i = 0; i < 10; i++) {
    const res = await withTenant(admin, tenant, (c) =>
      receiveInbound(c, {
        tenantId: tenant,
        phone: '+56961110001',
        channel: 'simulador',
        body: `Mensaje ${i}: ¿tienen horas para manicure?`,
      }),
    );
    conversacion = res.conversation.id;
  }
  const audio = await withTenant(admin, tenant, (c) =>
    receiveInbound(c, {
      tenantId: tenant,
      phone: '+56961110001',
      channel: 'simulador',
      type: 'audio',
      attachments: [{ key: 'x/audio.ogg', contentType: 'audio/ogg' }],
    }),
  );
  mensajeAudio = audio.message.id;
});

afterAll(async () => {
  for (const tabla of ['suggestions', 'agent_executions', 'agents', 'usage_meters', 'assignments', 'messages', 'conversations', 'contacts', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.end();
});

describe('parser (#48)', () => {
  it('extrae el JSON aunque venga con fences o texto alrededor', () => {
    const limpio = parseSuggestion(JSON_SUGERENCIA);
    expect(limpio).toMatchObject({ confianza: 0.86, intencion: 'agendar', calificacion: 'caliente', crearOportunidad: true });
    const conFence = parseSuggestion('```json\n' + JSON_SUGERENCIA + '\n```\nEso sería.');
    expect(conFence.sugerencia).toContain('¡Hola María!');
    const basura = parseSuggestion('Le sugiero responder que sí hay horas.');
    expect(basura.sugerencia).toBe('Le sugiero responder que sí hay horas.');
    expect(basura.confianza).toBe(0.5);
    expect(FORMATO_SUGERENCIA).toContain('crear_oportunidad');
  });
});

describe('el copiloto (#48)', () => {
  it('resume lo viejo, sugiere con contexto chico y guarda TODO', async () => {
    const sug = await withTenant(admin, tenant, (c) =>
      suggestForInbound(c, { tenantId: tenant, conversationId: conversacion }, fakeFactory),
    );
    expect(sug).not.toBeNull();
    expect(sug!.text).toContain('¡Hola María!');
    expect(sug!.confidence).toBe(0.86);
    expect(sug!.intent).toBe('agendar');
    expect(sug!.leadScore).toBe('caliente');
    expect(sug!.suggestDeal).toBe(true);

    // El resumen rodante quedó guardado (palanca de costo nº 1).
    const ctx = await withTenant(admin, tenant, (c) => getContext(c, tenant, conversacion));
    expect(ctx.summary).toContain('manicure');
    expect(ctx.unsummarized).toBe(0);

    // Dos ejecuciones: resumir + sugerir, ambas contadas.
    // now() empata dentro de la transacción: el ORDEN no es comparable.
    const ejecuciones = await admin.query(
      `SELECT task FROM agent_executions WHERE tenant_id = $1`,
      [tenant],
    );
    expect(ejecuciones.rows.map((r) => r.task).sort()).toEqual(['resumir', 'sugerir']);
    const evento = await admin.query(
      `SELECT payload FROM outbox WHERE name = 'agent.suggested' AND tenant_id = $1`,
      [tenant],
    );
    expect(evento.rows[0].payload.suggestDeal).toBe(true);
  });

  it('pending la entrega, expirar la mata, resolver y feedback funcionan', async () => {
    const viva = await withTenant(admin, tenant, (c) => pendingSuggestion(c, tenant, conversacion));
    expect(viva?.status).toBe('pending');

    await withTenant(admin, tenant, (c) =>
      feedbackSuggestion(c, { tenantId: tenant, suggestionId: viva!.id, feedback: 'down', reason: 'muy formal' }),
    );
    const conFeedback = await admin.query('SELECT feedback, feedback_reason FROM suggestions WHERE id = $1', [viva!.id]);
    expect(conFeedback.rows[0]).toEqual({ feedback: 'down', feedback_reason: 'muy formal' });

    await withTenant(admin, tenant, (c) =>
      resolveSuggestion(c, { tenantId: tenant, suggestionId: viva!.id, status: 'sent' }),
    );
    await expect(
      withTenant(admin, tenant, (c) =>
        resolveSuggestion(c, { tenantId: tenant, suggestionId: viva!.id, status: 'dismissed' }),
      ),
    ).rejects.toThrow(/ya no está vigente/);

    // Una nueva que expira: pending la marca y devuelve null.
    const otra = await withTenant(admin, tenant, (c) =>
      suggestForInbound(c, { tenantId: tenant, conversationId: conversacion }, fakeFactory),
    );
    await admin.query(`UPDATE suggestions SET expires_at = now() - interval '1 minute' WHERE id = $1`, [otra!.id]);
    expect(await withTenant(admin, tenant, (c) => pendingSuggestion(c, tenant, conversacion))).toBeNull();
    const expirada = await admin.query('SELECT status FROM suggestions WHERE id = $1', [otra!.id]);
    expect(expirada.rows[0].status).toBe('expired');
  });

  it('el análisis para la ficha junta resumen, lectura y acciones explicadas', async () => {
    const analisis = await withTenant(admin, tenant, (c) =>
      conversationAnalysis(c, tenant, conversacion),
    );
    expect(analisis.summary).toContain('manicure');
    expect(analisis.intent).toBe('agendar');
    expect(analisis.leadScore).toBe('caliente');
    expect(analisis.acciones.length).toBeGreaterThanOrEqual(2);
    expect(analisis.acciones[0].que).toContain('Sugirió');
  });

  it('la transcripción queda buscable y entra sola al contexto', async () => {
    const texto = await withTenant(admin, tenant, (c) =>
      transcribeInboundAudio(
        c,
        { tenantId: tenant, messageId: mensajeAudio, bytes: new Uint8Array(8), contentType: 'audio/ogg' },
        { transcribe: async () => 'Hola, quiero confirmar la hora de mañana por favor.' },
      ),
    );
    expect(texto).toContain('confirmar la hora');
    const fila = await admin.query('SELECT transcription FROM messages WHERE id = $1', [mensajeAudio]);
    expect(fila.rows[0].transcription).toContain('confirmar la hora');
    // El contexto la usa como cuerpo del mensaje (COALESCE).
    const ctx = await withTenant(admin, tenant, (c) => getContext(c, tenant, conversacion));
    expect(ctx.lastMessages.at(-1)?.body).toContain('confirmar la hora');
    // Y quedó contada como ejecución transcribir.
    const ej = await admin.query(
      `SELECT count(*)::int AS n FROM agent_executions WHERE tenant_id = $1 AND task = 'transcribir'`,
      [tenant],
    );
    expect(ej.rows[0].n).toBe(1);
  });

  it('sin agente activo no sugiere nada (y no gasta)', async () => {
    await admin.query(`UPDATE agents SET default_mode = 'off' WHERE tenant_id = $1`, [tenant]);
    const res = await withTenant(admin, tenant, (c) =>
      suggestForInbound(c, { tenantId: tenant, conversationId: conversacion }, fakeFactory),
    );
    expect(res).toBeNull();
    await admin.query(`UPDATE agents SET default_mode = 'assist' WHERE tenant_id = $1`, [tenant]);
  });
});
