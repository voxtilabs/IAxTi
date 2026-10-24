import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { receiveInbound } from '@iaxti/module-conversations';
import { processSuggest } from '../src/copilot';

// La escalada con su aviso ya firmado, como lo arma avisoDeEscalada (#1019).
// El módulo es el dueño de la voz; acá se prueba que el worker lo ENTREGA.
const AVISO =
  'Gracias por escribirnos. Te va a responder una persona del equipo.\n\nSofía — asistente virtual.';
vi.mock('@iaxti/module-agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@iaxti/module-agents')>()),
  providerAvailable: () => true,
  autoRespondForInbound: async () => ({ action: 'escalated', reason: 'pide_humano', aviso: AVISO }),
}));

let pool: Pool;
let tenantId: string;
beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  tenantId = (
    await pool.query("INSERT INTO tenants (name) VALUES ('aviso-al-escalar') RETURNING id")
  ).rows[0].id;
});
afterAll(async () => {
  await pool.query(
    'DELETE FROM processed_events WHERE event_id IN (SELECT id FROM outbox WHERE tenant_id=$1)',
    [tenantId],
  );
  await pool.query('DELETE FROM outbox WHERE tenant_id=$1', [tenantId]);
  await pool.end();
});

describe('al escalar, el cliente recibe el aviso — nunca silencio (#1019)', () => {
  it.each(['whatsapp', 'webchat'] as const)(
    'por %s sale el aviso con la política de respuesta',
    async (channel) => {
      const inbound = await withTenant(pool, tenantId, (c) =>
        receiveInbound(c, { tenantId, channel, phone: '+56944446666', body: 'una persona por favor' }),
      );
      const result = await processSuggest(pool, {
        tenantId,
        conversationId: inbound.conversation.id,
        messageId: inbound.message.id,
        requestId: 'req-aviso-escalada',
      });
      expect(result.escalated).toBe('pide_humano');
      expect(result.avisado).toBeDefined();

      const messages = await pool.query(
        "SELECT id, author_kind, body, delivery_status FROM messages WHERE conversation_id=$1 AND direction='out'",
        [inbound.conversation.id],
      );
      // Un solo mensaje: el aviso, tal cual lo firmó el módulo.
      expect(messages.rows).toEqual([
        {
          id: result.avisado,
          author_kind: 'agent',
          body: AVISO,
          delivery_status: channel === 'webchat' ? 'sent' : 'queued',
        },
      ]);
      // Es respuesta al entrante del cliente: viaja con política 'reply'
      // (ventana de 24 h abierta), nunca como plantilla ni campaña.
      const requests = await pool.query(
        "SELECT payload FROM outbox WHERE tenant_id=$1 AND name='message.delivery_requested' AND payload->>'messageId'=$2",
        [tenantId, result.avisado],
      );
      expect(requests.rows).toEqual(
        channel === 'webchat'
          ? []
          : [{ payload: { messageId: result.avisado, policy: 'reply' } }],
      );
    },
  );
});
