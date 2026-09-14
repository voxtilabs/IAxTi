import type { Pool } from 'pg';
import { withTenant } from '@iaxti/db';
import {
  PROVIDERS,
  autoRespondForInbound,
  providerAvailable,
  suggestForInbound,
  transcribeInboundAudio,
} from '@iaxti/module-agents';
import { getConversation, sendMessage, updateDeliveryStatus } from '@iaxti/module-conversations';
import { embeddingsAvailable, knowledgeContext, searchKnowledge } from '@iaxti/module-knowledge';
import type { Queue } from 'bullmq';
import { presignUrl, storageFromEnv } from '@iaxti/core';

// El copiloto (#48) corre en la cola `agents`, DESPUÉS del camino de
// entrada: la bandeja jamás espera a la IA. Sin llaves de proveedor, el
// job se salta en silencio (staging sin keys no acumula fallos).

export interface SuggestJob {
  moduleId?: 'agents';
  tenantId: string;
  conversationId: string;
  messageId: string;
  audioKey?: string;
  audioType?: string;
  /** El módulo knowledge está activo (#51): el worker consulta el RAG. */
  knowledgeActivo?: boolean;
  requestId?: string;
}

export async function processSuggest(
  pool: Pool,
  data: SuggestJob,
  colas: { outbound?: Queue } = {},
): Promise<{
  suggestionId?: string;
  autoReplied?: string;
  escalated?: string;
  skipped?: string;
  transcribed?: boolean;
}> {
  if (!PROVIDERS.some((p) => providerAvailable(p))) {
    return { skipped: 'sin llaves de proveedor de IA en este ambiente' };
  }
  return withTenant(pool, data.tenantId, async (client) => {
    let transcribed = false;
    // El audio primero (#48): transcrito, entra solo al contexto.
    if (data.audioKey && providerAvailable('google')) {
      const storage = storageFromEnv();
      if (storage) {
        try {
          const res = await fetch(presignUrl(storage, 'GET', data.audioKey));
          if (res.ok) {
            const texto = await transcribeInboundAudio(client, {
              tenantId: data.tenantId,
              messageId: data.messageId,
              bytes: new Uint8Array(await res.arrayBuffer()),
              contentType: data.audioType ?? 'audio/ogg',
              requestId: data.requestId,
            });
            transcribed = texto !== null;
          }
        } catch {
          /* audio sin transcribir no frena la sugerencia */
        }
      }
    }
    // El conocimiento del negocio (#51): retrieval con citas ANTES de
    // generar — la IA responde con lo que el negocio dice, no lo que
    // imagina. Sin módulo o sin llaves, sigue sin conocimiento (y el
    // modo autónomo escala más, por diseño del prompt).
    let knowledge: string | null = null;
    if (data.knowledgeActivo && embeddingsAvailable()) {
      try {
        const entrante = await client.query(
          `SELECT COALESCE(body, transcription) AS body FROM messages
            WHERE tenant_id = $1 AND id = $2`,
          [data.tenantId, data.messageId],
        );
        const pregunta = entrante.rows[0]?.body as string | null;
        if (pregunta) {
          knowledge = knowledgeContext(
            await searchKnowledge(client, { tenantId: data.tenantId, query: pregunta }),
          );
        }
      } catch {
        /* el RAG caído no frena la sugerencia */
      }
    }
    // El modo autónomo primero (#49): responde SOLO cuando el dueño lo
    // permitió; si no toca (assist), cae a la sugerencia de siempre.
    const auto = await autoRespondForInbound(client, {
      tenantId: data.tenantId,
      conversationId: data.conversationId,
      knowledge,
      requestId: data.requestId,
    });
    if (auto.action === 'escalated') {
      return { escalated: auto.reason, transcribed };
    }
    if (auto.action === 'reply') {
      // El cliente siempre ve QUIÉN escribe y cómo pedir humano (SPEC §13).
      const firmado = `${auto.text}\n\n${auto.agentName} — asistente virtual. Escribe "humano" y te paso con una persona.`;
      const message = await sendMessage(client, {
        tenantId: data.tenantId,
        conversationId: data.conversationId,
        authorKind: 'agent',
        type: 'texto',
        body: firmado,
        requestId: data.requestId,
      });
      const conv = await getConversation(client, data.tenantId, data.conversationId);
      if (conv.channel === 'whatsapp' && colas.outbound) {
        // La MISMA cola outbound del humano: rate limit y reintentos (#43).
        await colas.outbound.add(
          'send',
          { moduleId: 'whatsapp', tenantId: data.tenantId, messageId: message.id, requestId: data.requestId },
          { jobId: `out-${message.id}` },
        );
      } else {
        await updateDeliveryStatus(client, {
          tenantId: data.tenantId,
          messageId: message.id,
          status: 'sent',
          requestId: data.requestId,
        });
      }
      return { autoReplied: message.id, transcribed };
    }
    if (auto.action === 'none') {
      return { skipped: 'sin agente activo', transcribed };
    }
    const suggestion = await suggestForInbound(client, {
      tenantId: data.tenantId,
      conversationId: data.conversationId,
      messageId: data.messageId,
      knowledge,
      requestId: data.requestId,
    });
    return suggestion
      ? { suggestionId: suggestion.id, transcribed }
      : { skipped: 'el modelo no respondió', transcribed };
  });
}
