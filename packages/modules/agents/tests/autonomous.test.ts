import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { receiveInbound } from '@iaxti/module-conversations';
import { detectEscalation, parseAutonomous } from '../domain/escalation';
import {
  autoRespondForInbound,
  conversationMode,
  effectiveMode,
  inAutonomousHours,
  setConversationMode,
} from '../application/autonomous';
import { createAgent, updateAgent, listAgents } from '../application/agents';
import type { Agent } from '../application/agents';
import type { ModelPortFactory } from '../application/models';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
let agent: Agent;

const JSON_OK = `{"respuesta": "¡Hola! Sí, tenemos horas mañana a las 10:00.",
"confianza": 0.92, "intencion": "agendar", "calificacion": "tibio", "escalar": false, "motivo_escalar": null}`;

const fabricaOk: ModelPortFactory = () => ({
  async generate(args) {
    return {
      text: args.prompt.startsWith('Resume') ? 'Cliente pregunta por horas.' : JSON_OK,
      tokensIn: 100,
      tokensOut: 40,
    };
  },
});

function fabricaFija(text: string): ModelPortFactory {
  return () => ({ async generate() { return { text, tokensIn: 50, tokensOut: 20 }; } });
}

async function conversacionNueva(body: string): Promise<string> {
  const res = await withTenant(admin, tenant, (c) =>
    receiveInbound(c, {
      tenantId: tenant,
      phone: `+5695${String(Math.floor(Math.random() * 10 ** 7)).padStart(7, '0')}`,
      channel: 'simulador',
      body,
    }),
  );
  return res.conversation.id;
}

function alAire(conversationId: string, factory: ModelPortFactory) {
  return withTenant(admin, tenant, (c) =>
    autoRespondForInbound(c, { tenantId: tenant, conversationId }, factory),
  );
}

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('autonomo-test') RETURNING id");
  tenant = t.rows[0].id;
  agent = await withTenant(admin, tenant, (c) =>
    createAgent(c, { tenantId: tenant, name: 'Sofía', fallbackSystemPrompt: 'Eres Sofía.', actor: 'test' }),
  );
});

afterAll(async () => {
  for (const tabla of ['agent_conversation_modes', 'suggestions', 'agent_executions', 'agents', 'usage_meters', 'assignments', 'messages', 'conversations', 'contacts', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.end();
});

describe('detectores y parser (#49)', () => {
  it('pide humano y enojo/legal se detectan; lo normal no', () => {
    expect(detectEscalation('quiero hablar con una persona real')).toBe('pide_humano');
    expect(detectEscalation('páseme con un ejecutivo por favor')).toBe('pide_humano');
    expect(detectEscalation('esto es una estafa, voy a demandar')).toBe('enojo_o_legal');
    expect(detectEscalation('¿tienen horas para mañana?')).toBeNull();
    expect(detectEscalation(null)).toBeNull();
  });

  it('el parser autónomo JAMÁS deja pasar basura al cliente: escala', () => {
    expect(parseAutonomous('Le diría que sí hay horas.')).toMatchObject({
      escalar: true,
      motivoEscalar: 'error_del_modelo',
    });
    expect(parseAutonomous('{"respuesta": "", "escalar": false}')).toMatchObject({ escalar: true });
    expect(parseAutonomous(JSON_OK)).toMatchObject({ escalar: false, confianza: 0.92 });
  });
});

describe('el modo efectivo (#49): jamás autónomo por defecto', () => {
  it('recién creado, TODO es assist — aunque el horario esté vacío', async () => {
    const conv = await conversacionNueva('hola');
    const modo = await withTenant(admin, tenant, (c) =>
      effectiveMode(c, agent, tenant, conv),
    );
    expect(modo).toBe('assist');
  });

  it('defaultMode autonomous SIN horario sigue siendo assist; con horario, depende del reloj', async () => {
    const conv = await conversacionNueva('hola');
    const conHorario = {
      ...agent,
      defaultMode: 'autonomous' as const,
      autonomousHours: { start: '19:00', end: '09:00', days: [0, 1, 2, 3, 4, 5, 6] },
    };
    const sinHorario = { ...agent, defaultMode: 'autonomous' as const, autonomousHours: {} };
    const nocturno = new Date('2026-09-14T23:30:00');
    const laboral = new Date('2026-09-14T11:00:00');
    expect(await withTenant(admin, tenant, (c) => effectiveMode(c, sinHorario, tenant, conv, nocturno))).toBe('assist');
    expect(await withTenant(admin, tenant, (c) => effectiveMode(c, conHorario, tenant, conv, nocturno))).toBe('autonomous');
    expect(await withTenant(admin, tenant, (c) => effectiveMode(c, conHorario, tenant, conv, laboral))).toBe('assist');
    expect(inAutonomousHours({ start: '09:00', end: '18:00' }, laboral)).toBe(true);
    expect(inAutonomousHours({ start: '09:00', end: '18:00', days: [6] }, laboral)).toBe(false); // lunes
  });

  it('la marca manual manda: autonomous sin horario, y off apaga todo', async () => {
    const conv = await conversacionNueva('hola');
    await withTenant(admin, tenant, (c) =>
      setConversationMode(c, { tenantId: tenant, conversationId: conv, mode: 'autonomous', actor: 'user-1' }),
    );
    expect(await withTenant(admin, tenant, (c) => effectiveMode(c, agent, tenant, conv))).toBe('autonomous');
    await withTenant(admin, tenant, (c) =>
      setConversationMode(c, { tenantId: tenant, conversationId: conv, mode: 'off', actor: 'user-1' }),
    );
    expect(await withTenant(admin, tenant, (c) => effectiveMode(c, agent, tenant, conv))).toBe('off');
  });

  it('cuota al 100 % (#52): lo autónomo vuelve a assist en TODAS partes', async () => {
    const conv = await conversacionNueva('hola');
    await withTenant(admin, tenant, (c) =>
      setConversationMode(c, { tenantId: tenant, conversationId: conv, mode: 'autonomous', actor: 'user-1' }),
    );
    await admin.query('UPDATE agents SET autonomous_paused_at = now() WHERE id = $1', [agent.id]);
    expect(await withTenant(admin, tenant, (c) => effectiveMode(c, agent, tenant, conv))).toBe('assist');
    await admin.query('UPDATE agents SET autonomous_paused_at = NULL WHERE id = $1', [agent.id]);
  });
});

describe('la corrida autónoma (#49)', () => {
  it('responde sola, registra la execution responder y publica agent.acted', async () => {
    const conv = await conversacionNueva('¿tienen horas para mañana?');
    await withTenant(admin, tenant, (c) =>
      setConversationMode(c, { tenantId: tenant, conversationId: conv, mode: 'autonomous', actor: 'user-1' }),
    );
    const res = await alAire(conv, fabricaOk);
    expect(res.action).toBe('reply');
    if (res.action !== 'reply') return;
    expect(res.text).toContain('10:00');
    expect(res.agentName).toBe('Sofía');

    const ej = await admin.query(
      `SELECT count(*)::int AS n FROM agent_executions WHERE tenant_id = $1 AND task = 'responder'`,
      [tenant],
    );
    expect(ej.rows[0].n).toBe(1);
    const evento = await admin.query(
      `SELECT payload FROM outbox WHERE name = 'agent.acted' AND tenant_id = $1`,
      [tenant],
    );
    expect(evento.rows[0].payload.conversationId).toBe(conv);
  });

  it('el cliente pide humano: escala SIN gastar un token y vuelve a assist', async () => {
    const conv = await conversacionNueva('Quiero hablar con una persona, no con un bot');
    await withTenant(admin, tenant, (c) =>
      setConversationMode(c, { tenantId: tenant, conversationId: conv, mode: 'autonomous', actor: 'user-1' }),
    );
    const antes = await admin.query('SELECT count(*)::int AS n FROM agent_executions WHERE tenant_id = $1', [tenant]);
    const res = await alAire(conv, fabricaOk);
    expect(res).toEqual({ action: 'escalated', reason: 'pide_humano' });
    const despues = await admin.query('SELECT count(*)::int AS n FROM agent_executions WHERE tenant_id = $1', [tenant]);
    expect(despues.rows[0].n).toBe(antes.rows[0].n); // ni un token

    expect(await withTenant(admin, tenant, (c) => conversationMode(c, tenant, conv))).toBe('assist');
    const eventos = await admin.query(
      `SELECT name, payload FROM outbox WHERE tenant_id = $1 AND name IN ('agent.escalated','conversation.handoff_requested') AND payload->>'conversationId' = $2`,
      [tenant, conv],
    );
    expect(eventos.rows.map((r) => r.name).sort()).toEqual(['agent.escalated', 'conversation.handoff_requested']);
  });

  it('la regla del tenant asigna el handoff a alguien concreto', async () => {
    const humano = randomUUID();
    agent = await withTenant(admin, tenant, (c) =>
      updateAgent(c, { tenantId: tenant, agentId: agent.id, limits: { handoff_user_id: humano }, actor: 'test' }),
    );
    const conv = await conversacionNueva('me parece una estafa esto');
    await withTenant(admin, tenant, (c) =>
      setConversationMode(c, { tenantId: tenant, conversationId: conv, mode: 'autonomous', actor: 'user-1' }),
    );
    const res = await alAire(conv, fabricaOk);
    expect(res).toEqual({ action: 'escalated', reason: 'enojo_o_legal' });
    const owner = await admin.query('SELECT owner_id FROM conversations WHERE id = $1', [conv]);
    expect(owner.rows[0].owner_id).toBe(humano);
    agent = await withTenant(admin, tenant, (c) =>
      updateAgent(c, { tenantId: tenant, agentId: agent.id, limits: {}, actor: 'test' }),
    );
  });

  it('confianza bajo el umbral del tenant: escala en vez de enviar', async () => {
    const conv = await conversacionNueva('¿cuánto sale el más caro?');
    await withTenant(admin, tenant, (c) =>
      setConversationMode(c, { tenantId: tenant, conversationId: conv, mode: 'autonomous', actor: 'user-1' }),
    );
    const dudosa = JSON_OK.replace('0.92', '0.40');
    const res = await alAire(conv, fabricaFija(dudosa));
    expect(res).toEqual({ action: 'escalated', reason: 'confianza_baja' });
  });

  it('el modelo pide escalar (fuera de conocimiento) y se le hace caso', async () => {
    const conv = await conversacionNueva('¿tienen stock del producto X?');
    await withTenant(admin, tenant, (c) =>
      setConversationMode(c, { tenantId: tenant, conversationId: conv, mode: 'autonomous', actor: 'user-1' }),
    );
    const res = await alAire(
      conv,
      fabricaFija('{"respuesta": "", "confianza": 0.9, "escalar": true, "motivo_escalar": "fuera_de_conocimiento"}'),
    );
    expect(res).toEqual({ action: 'escalated', reason: 'fuera_de_conocimiento' });
  });

  it('más de N turnos sin avanzar: escala antes de responder de nuevo', async () => {
    agent = (await withTenant(admin, tenant, (c) => listAgents(c, tenant)))[0];
    const conv = await conversacionNueva('hola');
    await withTenant(admin, tenant, (c) =>
      setConversationMode(c, { tenantId: tenant, conversationId: conv, mode: 'autonomous', actor: 'user-1' }),
    );
    for (let i = 0; i < 5; i++) {
      await admin.query(
        `INSERT INTO messages (tenant_id, conversation_id, direction, type, body, author_kind, delivery_status)
         VALUES ($1, $2, 'out', 'texto', $3, 'agent', 'sent')`,
        [tenant, conv, `respuesta ${i}`],
      );
    }
    const res = await alAire(conv, fabricaOk);
    expect(res).toEqual({ action: 'escalated', reason: 'sin_avance' });
  });

  it('en assist no responde nada solo: cae a la sugerencia de siempre', async () => {
    const conv = await conversacionNueva('hola, ¿precios?');
    const res = await alAire(conv, fabricaOk);
    expect(res).toEqual({ action: 'assist' });
  });
});

describe('cortado por el tope de salida (#310)', () => {
  const cortado: ModelPortFactory = () => ({
    async generate() {
      // Lo que devuelve de verdad un modelo que razona y se queda sin
      // espacio: JSON que empieza y no cierra.
      return { text: '{"respuesta": "¡Hola! Para darte el valor exa', tokensIn: 100, tokensOut: 1500, truncada: true };
    },
  });

  it('escala con el motivo VERDADERO, no como error del modelo', async () => {
    const conv = await conversacionNueva('Hola, ¿cuánto sale el corte?');
    await withTenant(admin, tenant, (c) =>
      setConversationMode(c, { tenantId: tenant, conversationId: conv, mode: 'autonomous', actor: 'user-1' }),
    );
    const res = await alAire(conv, cortado);
    // En un `toMatchObject` y no en dos expects: `AutonomousOutcome` es una
    // unión discriminada y un `expect` no la estrecha, así que leer `.reason`
    // suelto no compila. De paso, el fallo dice las dos cosas de una.
    //
    // El modelo no falló: no le alcanzó el espacio, y eso se arregla distinto.
    // Con 'error_del_modelo' el dueño cree que el proveedor anda mal y no que
    // sus conversaciones son largas.
    expect(res).toMatchObject({ action: 'escalated', reason: 'respuesta_cortada' });
  });

  it('nunca le manda media frase al cliente', async () => {
    const conv = await conversacionNueva('¿Tienen hora mañana?');
    await withTenant(admin, tenant, (c) =>
      setConversationMode(c, { tenantId: tenant, conversationId: conv, mode: 'autonomous', actor: 'user-1' }),
    );
    const res = await alAire(conv, cortado);
    expect(res.action).not.toBe('reply');
    expect(JSON.stringify(res)).not.toContain('valor exa');
  });
});

