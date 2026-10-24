import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { receiveInbound } from '@iaxti/module-conversations';
import { esEcoDelContexto } from '../domain/escalation';
import { autoRespondForInbound, setConversationMode } from '../application/autonomous';
import { createAgent, updateAgent } from '../application/agents';
import type { ModelPortFactory } from '../application/models';

/**
 * El eco del contexto no viaja al cliente (#1021).
 *
 * Medido el 24/10: la «respuesta» autónoma fue el bloque de conocimiento
 * COMPLETO — marcador interno «— [fuente]» incluido, más datos que nadie
 * preguntó. El prompt lo prohíbe desde #1031, pero es estocástico; esto es
 * el cinturón determinista. Con #1019, escalar significa que el cliente
 * recibe el aviso de que viene una persona — nunca el volcado.
 */

const CONOCIMIENTO =
  'CONOCIMIENTO DEL NEGOCIO (responde SOLO con esto; cita la fuente): ' +
  '— [Horarios y precios del salón] Horario de atención: lunes a viernes de 10:00 a 19:00, ' +
  'sábados de 10:00 a 14:00. El corte de pelo cuesta $18.000 y el corte más barba $24.000. ' +
  'La coloración parte en $45.000 según el largo. Atendemos con hora agendada en ' +
  'Av. Providencia 1234, Santiago. Aceptamos tarjetas y transferencia.';

// El volcado real de la ejecución medida, marcador incluido.
const VOLCADO =
  '— [Horarios y precios del salón] Horario de atención: lunes a viernes de 10:00 a 19:00, ' +
  'sábados de 10:00 a 14:00. El corte de pelo cuesta $18.000 y el corte más barba $24.000. ' +
  '(según Lista de precios)';

describe('el detector de eco (#1021)', () => {
  it('el marcador interno «— [» basta: ese texto no existe en una respuesta legítima', () => {
    expect(esEcoDelContexto(VOLCADO, CONOCIMIENTO)).toBe(true);
    // Incluso sin conocimiento a mano, el marcador delata el volcado.
    expect(esEcoDelContexto(VOLCADO, null)).toBe(true);
  });

  it('un tramo largo copiado literal es eco aunque el modelo quite el marcador', () => {
    const sinMarcador =
      'Horario de atención: lunes a viernes de 10:00 a 19:00, sábados de 10:00 a 14:00. ' +
      'El corte de pelo cuesta $18.000 y el corte más barba $24.000.';
    expect(esEcoDelContexto(sinMarcador, CONOCIMIENTO)).toBe(true);
  });

  it('la respuesta buena en sus palabras, citando la fuente, NO es eco', () => {
    const buena =
      'Hola Carla! El corte de pelo cuesta $18.000 y los sábados atendemos hasta las 14:00 ' +
      '(según Horarios y precios del salón). ¿Te ayudo en algo más?';
    expect(esEcoDelContexto(buena, CONOCIMIENTO)).toBe(false);
  });

  it('sin conocimiento no hay con qué comparar: no es eco', () => {
    expect(esEcoDelContexto('Hola! ¿En qué te ayudo?', null)).toBe(false);
    expect(esEcoDelContexto('Hola! ¿En qué te ayudo?', undefined)).toBe(false);
  });
});

describe('la corrida autónoma escala el volcado en vez de enviarlo', () => {
  const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
  let admin: Pool;
  let tenant: string;

  const fabricaQueVuelca: ModelPortFactory = () => ({
    async generate() {
      return {
        text: JSON.stringify({
          respuesta: VOLCADO,
          confianza: 0.9,
          intencion: 'consulta',
          calificacion: 'tibio',
          escalar: false,
          motivo_escalar: null,
        }),
        tokensIn: 300,
        tokensOut: 120,
      };
    },
  });

  beforeAll(async () => {
    admin = createPool(ADMIN_URL);
    await runMigrations(admin);
    const t = await admin.query("INSERT INTO tenants (name) VALUES ('eco-no-viaja') RETURNING id");
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

  it('confianza 0,9 y escalar:false — igual escala, con el motivo verdadero y su aviso', async () => {
    const inbound = await withTenant(admin, tenant, (c) =>
      receiveInbound(c, {
        tenantId: tenant,
        phone: '+56999001501',
        channel: 'simulador',
        body: '¿Cuánto cuesta el corte?',
      }),
    );
    await withTenant(admin, tenant, (c) =>
      setConversationMode(c, {
        tenantId: tenant,
        conversationId: inbound.conversation.id,
        mode: 'autonomous',
        actor: 'user-1',
      }),
    );
    const res = await withTenant(admin, tenant, (c) =>
      autoRespondForInbound(
        c,
        { tenantId: tenant, conversationId: inbound.conversation.id, knowledge: CONOCIMIENTO },
        fabricaQueVuelca,
      ),
    );
    expect(res).toMatchObject({ action: 'escalated', reason: 'eco_del_contexto' });
    if (res.action !== 'escalated') throw new Error('esperaba escalated');
    // El cliente recibe el aviso (#1019), jamás el bloque pegado.
    expect(res.aviso).toContain('Te va a responder una persona del equipo');
    expect(res.aviso).not.toContain('— [');
  });
});
