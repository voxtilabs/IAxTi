import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { receiveInbound } from '@iaxti/module-conversations';
import { autoRespondForInbound, setConversationMode } from '../application/autonomous';
import { createAgent, updateAgent } from '../application/agents';
import { formatoAutonomo } from '../domain/escalation';
import type { ModelPortFactory } from '../application/models';

/**
 * En autónomo, contestar y DEJAR LA ACCIÓN propuesta (#1030).
 *
 * Hasta esto, el modo autónomo solo tenía responder o escalar: cuando el
 * cliente además pedía algo accionable (agendar, pagar), la acción se
 * perdía. Ahora viaja como sugerencia SIN TEXTO — la respuesta ya salió,
 * lo único pendiente es la acción — con la misma validación de #1000 y el
 * mismo visto bueno de una persona.
 */

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;

function fabricaQueDeja(accion: unknown): ModelPortFactory {
  return () => ({
    async generate() {
      return {
        text: JSON.stringify({
          respuesta: 'Sí, tenemos horas el jueves. Te dejo la solicitud lista para que el equipo la confirme.',
          confianza: 0.9,
          intencion: 'agendar',
          calificacion: 'caliente',
          escalar: false,
          motivo_escalar: null,
          accion,
        }),
        tokensIn: 200,
        tokensOut: 80,
      };
    },
  });
}

async function conversacionAutonoma(telefono: string): Promise<string> {
  const inbound = await withTenant(admin, tenant, (c) =>
    receiveInbound(c, { tenantId: tenant, channel: 'simulador', phone: telefono, body: 'tienen hora el jueves?' }),
  );
  await withTenant(admin, tenant, (c) =>
    setConversationMode(c, {
      tenantId: tenant,
      conversationId: inbound.conversation.id,
      mode: 'autonomous',
      actor: 'user-1',
    }),
  );
  return inbound.conversation.id;
}

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('accion-en-autonomo') RETURNING id");
  tenant = t.rows[0].id;
  const agente = await withTenant(admin, tenant, (c) =>
    createAgent(c, { tenantId: tenant, name: 'José', actor: 'test' }),
  );
  await withTenant(admin, tenant, (c) =>
    updateAgent(c, { tenantId: tenant, agentId: agente.id, defaultMode: 'autonomous', actor: 'test' }),
  );
});

afterAll(async () => {
  for (const tabla of ['agent_conversation_modes', 'suggestions', 'agent_executions', 'agents', 'usage_meters', 'assignments', 'messages', 'conversations', 'contacts', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.end();
});

describe('la acción también en autónomo (#1030)', () => {
  it('responde Y deja la sugerencia-acción sin texto, con su evento', async () => {
    const conv = await conversacionAutonoma('+56999001701');
    const res = await withTenant(admin, tenant, (c) =>
      autoRespondForInbound(
        c,
        { tenantId: tenant, conversationId: conv, activeModules: ['calendar', 'conversations', 'crm'] },
        fabricaQueDeja({ herramienta: 'agenda.agendar', argumentos: { cuando: 'jueves 16:00' } }),
      ),
    );
    expect(res.action).toBe('reply');

    const sug = await admin.query(
      'SELECT text, accion, status FROM suggestions WHERE tenant_id = $1 AND conversation_id = $2',
      [tenant, conv],
    );
    expect(sug.rowCount).toBe(1);
    // Sin texto: la respuesta ya salió; lo único pendiente es la acción.
    expect(sug.rows[0].text).toBe('');
    expect(sug.rows[0].status).toBe('pending');
    expect(sug.rows[0].accion).toMatchObject({ herramienta: 'agenda.agendar' });

    const evento = await admin.query(
      `SELECT count(*)::int AS n FROM outbox WHERE tenant_id = $1 AND name = 'agent.suggested' AND payload->>'conversationId' = $2`,
      [tenant, conv],
    );
    expect(evento.rows[0].n).toBe(1);
  });

  it('una acción que no está en la lista se pierde y la respuesta viaja igual', async () => {
    const conv = await conversacionAutonoma('+56999001702');
    const res = await withTenant(admin, tenant, (c) =>
      autoRespondForInbound(
        c,
        { tenantId: tenant, conversationId: conv, activeModules: ['calendar', 'conversations', 'crm'] },
        fabricaQueDeja({ herramienta: 'tenants.delete', argumentos: {} }),
      ),
    );
    expect(res.action).toBe('reply');
    const sug = await admin.query(
      'SELECT count(*)::int AS n FROM suggestions WHERE tenant_id = $1 AND conversation_id = $2',
      [tenant, conv],
    );
    // Nada que confirmar: no se crea una sugerencia vacía de verdad.
    expect(sug.rows[0].n).toBe(0);
  });

  it('el prompt autónomo ofrece el campo accion SOLO cuando hay catálogo', () => {
    const con = formatoAutonomo({ moneyLimitClp: null, acciones: '- agenda.agendar: Agendar una hora.' });
    expect(con).toContain('"accion"');
    expect(con).toContain('jamás "ya te lo agendé"');
    // Sin catálogo (módulos apagados), el campo ni se ofrece: proponer sin
    // lista es proponer a ciegas, que es lo que #1020 vino a matar.
    const sin = formatoAutonomo({ moneyLimitClp: null });
    expect(sin).not.toContain('"accion"');
  });
});
