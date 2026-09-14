import type { Pool } from 'pg';
import { withTenant } from '@iaxti/db';
import { PROVIDERS, providerAvailable, suggestForInbound, transcribeInboundAudio } from '@iaxti/module-agents';
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
  requestId?: string;
}

export async function processSuggest(
  pool: Pool,
  data: SuggestJob,
): Promise<{ suggestionId?: string; skipped?: string; transcribed?: boolean }> {
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
    const suggestion = await suggestForInbound(client, {
      tenantId: data.tenantId,
      conversationId: data.conversationId,
      messageId: data.messageId,
      requestId: data.requestId,
    });
    return suggestion
      ? { suggestionId: suggestion.id, transcribed }
      : { skipped: 'sin agente activo o el modelo no respondió', transcribed };
  });
}
