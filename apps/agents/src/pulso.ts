import type { Pool } from 'pg';
import { withTenant } from '@iaxti/db';
import {
  agenteConPulso,
  effectiveMode,
  listAgents,
  textoParaRetomar,
  providerAvailable,
  PROVIDERS,
} from '@iaxti/module-agents';
import { getConversation, sendMessage, updateDeliveryStatus, salePorProveedor } from '@iaxti/module-conversations';
import { knowledgeContext, searchKnowledge, embeddingsAvailable } from '@iaxti/module-knowledge';
import type { ModuleRegistry } from '@iaxti/core';

export interface PulsoJob {
  moduleId?: 'agents';
  tenantId: string;
  conversationId: string;
  knowledgeActivo?: boolean;
  requestId?: string;
}

/**
 * Retoma UNA conversación (#1210): genera el mensaje y lo manda.
 *
 * Quién decide a quién le toca ya lo decidió el barrido de `scheduled`; acá
 * solo se vuelve a comprobar lo que pudo cambiar en el minuto que el job
 * estuvo en la cola —que el pulso siga prendido y que la conversación siga en
 * modo autónomo—. Volver a comprobarlo no es desconfianza del barrido: entre
 * que se encoló y que corre, el dueño pudo tomar la conversación.
 */
export async function processPulso(
  pool: Pool,
  data: PulsoJob,
  colas: { registry?: ModuleRegistry } = {},
): Promise<{ enviado?: string; skipped?: string }> {
  if (!PROVIDERS.some((p) => providerAvailable(p))) {
    return { skipped: 'sin llaves de proveedor de IA en este ambiente' };
  }
  return withTenant(pool, data.tenantId, async (client) => {
    const conPulso = agenteConPulso(await listAgents(client, data.tenantId));
    if (!conPulso) return { skipped: 'el pulso se apagó mientras el job esperaba' };
    const { agent } = conPulso;
    // El dueño pudo tomar la conversación en el minuto que el job esperó. Un
    // pulso sobre una conversación que una persona está atendiendo le pisa el
    // trabajo, que es peor que no mandar nada.
    const modo = await effectiveMode(client, agent, data.tenantId, data.conversationId);
    if (modo !== 'autonomous') return { skipped: `la conversación quedó en ${modo}` };

    // El conocimiento del negocio, buscado con lo ÚLTIMO que dijo el cliente:
    // es lo que hace que el mensaje enganche con su caso y no sea un texto
    // igual para todos. Sin módulo o sin llaves, se retoma sin él.
    let knowledge: string | null = null;
    if (data.knowledgeActivo && embeddingsAvailable()) {
      try {
        const ultimo = await client.query(
          `SELECT COALESCE(body, transcription) AS body FROM messages
            WHERE tenant_id = $1 AND conversation_id = $2 AND direction = 'in'
            ORDER BY seq DESC LIMIT 1`,
          [data.tenantId, data.conversationId],
        );
        const pregunta = ultimo.rows[0]?.body as string | null;
        if (pregunta) {
          knowledge = knowledgeContext(
            await searchKnowledge(client, { tenantId: data.tenantId, query: pregunta }),
          );
        }
      } catch {
        /* el RAG caído no frena el pulso */
      }
    }

    const activeModules =
      colas.registry
        ?.health()
        .filter((m) => m.active)
        .map((m) => m.id) ?? [];

    const { texto, motivo } = await textoParaRetomar(client, {
      tenantId: data.tenantId,
      conversationId: data.conversationId,
      agent,
      knowledge,
      activeModules,
      ...(data.requestId ? { requestId: data.requestId } : {}),
    });
    if (!texto) return { skipped: `el modelo no dejó texto (${motivo})` };

    // La firma, igual que en la respuesta autónoma (SPEC §13): el cliente
    // siempre ve QUIÉN le escribe y cómo pedir una persona.
    const body = `${texto}\n\n${agent.name} — asistente virtual. Escribe "humano" y te paso con una persona.`;
    const message = await sendMessage(client, {
      tenantId: data.tenantId,
      conversationId: data.conversationId,
      authorKind: 'agent',
      type: 'texto',
      body,
      // `business` y no `reply`: nadie preguntó. Así la cola le aplica el
      // horario de silencio y el consentimiento, que es lo que corresponde a
      // todo lo que empieza el negocio.
      delivery: 'business',
      // El sello que lo hace contable (#1210): sin esto el tope por persona
      // no se puede calcular, porque un pulso no se distingue de una
      // respuesta.
      meta: { pulso: '1' },
      ...(data.requestId ? { requestId: data.requestId } : {}),
    });
    const conv = await getConversation(client, data.tenantId, data.conversationId);
    if (!salePorProveedor(conv.channel)) {
      await updateDeliveryStatus(client, {
        tenantId: data.tenantId,
        messageId: message.id,
        status: 'sent',
        ...(data.requestId ? { requestId: data.requestId } : {}),
      });
    }
    return { enviado: message.id };
  });
}
