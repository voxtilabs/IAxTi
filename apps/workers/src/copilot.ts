import type { Pool, PoolClient } from 'pg';
import type { ModuleRegistry } from '@iaxti/core';
import { withTenant } from '@iaxti/db';
import {
  PROVIDERS,
  activeAgent,
  allowedToolsFor,
  autoRespondForInbound,
  herramientasExpuestas,
  providerAvailable,
  suggestForInbound,
  transcribeInboundAudio,
} from '@iaxti/module-agents';
import type { HerramientaExpuesta } from '@iaxti/module-agents';
import {
  getContext,
  getConversation,
  sendMessage,
  updateDeliveryStatus,
} from '@iaxti/module-conversations';
import {
  embeddingsAvailable,
  getProduct,
  knowledgeContext,
  searchKnowledge,
} from '@iaxti/module-knowledge';
import { huecosDelDia } from '@iaxti/module-calendar';
import { roleOf } from '@iaxti/module-identity';
import {
  baseRoleHasPermission,
  customRolePermissions,
  isBaseRole,
} from '@iaxti/module-authorization';
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
  colas: { outbound?: Queue; registry?: ModuleRegistry } = {},
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
    // Las herramientas de lectura (#240). Existían declaradas, con su
    // ejecutor y sus tests, y no las llamaba NADIE: el mismo agujero que
    // denunciaba el issue, un piso más arriba. Acá se conectan.
    //
    // La identidad es la del DUEÑO de la conversación, no la del agente:
    // una herramienta jamás puede traer lo que esa persona no podría ver.
    // Una conversación sin dueño se queda sin herramientas, y está bien:
    // sin persona no hay permiso contra el cual verificar nada.
    const tools = await herramientasDeLaConversacion(client, data, colas.registry);

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
          {
            moduleId: 'whatsapp',
            tenantId: data.tenantId,
            messageId: message.id,
            requestId: data.requestId,
            // Explícito aunque el valor sea el que ya tomaba por omisión: el
            // autónomo RESPONDE a quien acaba de escribir, así que no es un
            // envío iniciado por el negocio. El tipo lo pide obligatorio y
            // acá no se estaba pasando — el default silencioso acertaba, que
            // es la peor forma de acertar.
            initiatedByBusiness: false,
          },
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
      tools,
      requestId: data.requestId,
    });
    return suggestion
      ? { suggestionId: suggestion.id, transcribed }
      : { skipped: 'el modelo no respondió', transcribed };
  });
}

/**
 * Las herramientas de lectura que este agente puede pedir en ESTA
 * conversación (#240).
 *
 * Tres filtros, en este orden: lo que el agente tiene configurado, lo que
 * los módulos activos ofrecen (`allowedToolsFor`), y el permiso de la
 * persona dueña de la conversación —ese último lo verifica
 * `ejecutarHerramienta` en cada llamada, no acá, porque el permiso de
 * alguien puede cambiar mientras la conversación sigue abierta.
 */
async function herramientasDeLaConversacion(
  client: PoolClient,
  data: SuggestJob,
  registry?: ModuleRegistry,
): Promise<HerramientaExpuesta[]> {
  if (!registry) return [];
  const agent = await activeAgent(client, data.tenantId);
  if (!agent) return [];

  const conv = await getConversation(client, data.tenantId, data.conversationId);
  const dueno = (conv as { ownerId?: string | null }).ownerId ?? null;
  if (!dueno) return [];

  const permisos = await permisosDe(client, data.tenantId, dueno, registry);

  return herramientasExpuestas(
    client,
    {
      tenantId: data.tenantId,
      habilitadas: allowedToolsFor(agent, registry),
      actorUserId: dueno,
      agentId: agent.id,
      conversationId: data.conversationId,
      requestId: data.requestId,
    },
    {
      actorPuede: (permiso) => permisos.has(permiso),
      habilitadas: allowedToolsFor(agent, registry),
      getContext: (conversationId) => getContext(client, data.tenantId, conversationId),
      buscarConocimiento: (query) => searchKnowledge(client, { tenantId: data.tenantId, query }),
      buscarProducto: (query) => getProduct(client, data.tenantId, query),
      horariosLibres: (dia) =>
        huecosDelDia(client, { tenantId: data.tenantId, ownerId: dueno, dia }),
    },
  );
}

/**
 * Los permisos efectivos de la persona dueña de la conversación.
 *
 * Es la MISMA resolución que hace el guard de la API —rol base contra el
 * catálogo, o los permisos del rol a medida—, porque si acá fuera distinta
 * la IA podría traer por un camino lo que la persona no puede ver por el
 * otro. Un usuario sin rol en el tenant no tiene permisos: conjunto vacío,
 * y ninguna herramienta corre.
 */
async function permisosDe(
  client: PoolClient,
  tenantId: string,
  userId: string,
  registry?: ModuleRegistry,
): Promise<Set<string>> {
  const rol = await roleOf(client, tenantId, userId);
  if (!rol) return new Set();
  if (isBaseRole(rol)) {
    const catalogo = new Set(registry ? registry.permissionsCatalog().keys() : []);
    return new Set([...catalogo].filter((p) => baseRoleHasPermission(rol, p, catalogo)));
  }
  return new Set(await customRolePermissions(client, tenantId, rol));
}
