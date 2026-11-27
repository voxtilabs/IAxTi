import type { Pool, PoolClient } from 'pg';
import type { Job } from 'bullmq';
import { withTenant } from '@iaxti/db';
import { publishEvent } from '@iaxti/core';
import {
  findAccountById,
  fijarHistorialDeChats,
  type ChannelAccountRef,
  type HistorialDeChats,
} from '@iaxti/module-channels';
import {
  baseDeZernio,
  credencialDeLaCuenta,
  llamarAZernio,
  type ConfigDeZernio,
} from '@iaxti/module-whatsapp';
import {
  MAX_CHATS,
  MAX_MENSAJES_POR_CHAT,
  aprenderDeLosChats,
  type ChatParaAprender,
} from '@iaxti/module-agents';
import { crearFuenteAprendida } from '@iaxti/module-knowledge';

/**
 * El job de aprender de los chats (#1406, ADR-0039).
 *
 * Lee los últimos 50 chats del número que el dueño autorizó — redactados por
 * el dominio del módulo agents antes de salir hacia el proveedor — y deja lo
 * extraído como una fuente `por_revisar` que la búsqueda del asistente no ve
 * hasta que la dueña la apruebe.
 *
 * Tres reglas que este archivo no puede permitirse romper:
 *
 * 1. **Sin autorización no se llama a Zernio.** El primer paso carga la
 *    cuenta y mira `config.historial`: sin marca, retirada o ya resuelta, el
 *    job termina sin una sola petición afuera.
 * 2. **Los chats no se guardan ni se loguean.** Lo que llega de Zernio vive
 *    en memoria, va al dominio (que redacta) y se descarta. Los logs de este
 *    archivo son conteos e ids, y el payload del job solo lleva ids.
 * 3. **Idempotente por cuenta.** La fuente, el estado `listo` y el aviso se
 *    escriben en UNA transacción: si el proceso muere antes del commit no
 *    quedó nada (y el reintento vuelve a leer), y si murió después, el
 *    estado ya dice `listo` y el reintento termina solo.
 */

/** El sobre del job (SPEC §28): módulo dueño y tenant SIEMPRE. */
export interface AprenderJobData {
  moduleId: 'whatsapp';
  tenantId: string;
  accountId: string;
  requestId?: string;
  /** Cuándo empezó a esperar a Meta (ISO): contra esto se mide el tope. */
  desde?: string;
}

/** Cuánto esperar entre vueltas mientras Meta no mande el historial. */
export const ESPERA_DE_META_MS = 15 * 60_000;
/** Pasadas 48 h esperando, el trabajo se da por vencido. */
export const TOPE_DE_ESPERA_MS = 48 * 3_600_000;

/** Meta todavía no compartió el historial: el job se reprograma solo. */
export class EsperandoAMetaError extends Error {
  constructor(public readonly ms: number) {
    super(`Meta no ha compartido el historial: reintento en ${Math.round(ms / 60000)} min.`);
    this.name = 'EsperandoAMetaError';
  }
}

/** El nombre con el que se encola (`main.ts` y la API lo usan). */
export const NOMBRE_DEL_JOB = 'aprender';

type JobAprender = Pick<Job, 'attemptsMade' | 'opts'> & { data: AprenderJobData };
export type { JobAprender };

/** Lo que Meta puede decir del historial, según el health de Zernio. */
type EstadoDeMeta = 'requested' | 'imported' | 'declined' | 'already_synced' | 'refused';

/** La respuesta de `/v1/inbox/conversations` (spec de Zernio, v1.854). */
interface ConversacionDeZernio {
  id: string;
  isGroup?: boolean;
}

/** La respuesta de `/v1/inbox/conversations/{id}/messages`. */
interface MensajeDeZernio {
  message: string | null;
  direction: 'incoming' | 'outgoing';
  createdAt: string;
}

interface Autorizacion {
  account: ChannelAccountRef;
  /** La marca completa, tal como está en la cuenta. */
  historial: HistorialDeChats;
}

/**
 * La autorización vigente, sin llamar a Zernio.
 *
 * `null` es «no hay»: nunca la hubo, se retiró, o la corrida ya cerró — para
 * este job las tres son lo mismo, y el rastro de la diferencia vive en la
 * auditoría. Los únicos estados que autorizan a leer son los de espera:
 * cualquier otro que aparezca sería releer chats que nadie volvió a
 * autorizar.
 */
async function autorizacionVigente(pool: Pool, data: AprenderJobData): Promise<Autorizacion | null> {
  return withTenant(pool, data.tenantId, async (c) => {
    const account = await findAccountById(c, data.accountId);
    if (!account || account.tenantId !== data.tenantId) return null;
    const historial = account.config.historial as Partial<HistorialDeChats> | undefined;
    if (
      !historial ||
      typeof historial.autorizadoPor !== 'string' ||
      typeof historial.autorizadoEl !== 'string' ||
      (historial.estado !== 'esperando' && historial.estado !== 'requested')
    ) {
      return null;
    }
    return { account, historial: historial as HistorialDeChats };
  });
}

/** Cierra la corrida moviendo el estado, conservando quién autorizó. */
async function cerrar(
  client: PoolClient,
  data: AprenderJobData,
  autorizacion: Autorizacion,
  estado: HistorialDeChats['estado'],
): Promise<void> {
  await fijarHistorialDeChats(client, {
    tenantId: data.tenantId,
    accountId: data.accountId,
    historial: { ...autorizacion.historial, estado },
  });
}

/** `cerrar` con su propia transacción, para antes de entrar a la del final. */
async function cerrarAparte(
  pool: Pool,
  data: AprenderJobData,
  autorizacion: Autorizacion,
  estado: HistorialDeChats['estado'],
): Promise<void> {
  await withTenant(pool, data.tenantId, (c) => cerrar(c, data, autorizacion, estado));
}

/** La llave del NEGOCIO de esta cuenta, como `ConfigDeZernio`. */
async function zernioDeLaCuenta(
  account: ChannelAccountRef,
  fetchImpl: typeof fetch,
): Promise<ConfigDeZernio> {
  const llave = await credencialDeLaCuenta(account);
  if (!llave) {
    throw new Error('Este canal no tiene su llave del proveedor configurada: no se pueden leer sus chats.');
  }
  return { apiKey: llave, apiBase: baseDeZernio(), fetchImpl };
}

/**
 * El estado del historial según Meta, leído del health de la cuenta.
 *
 * Ausente o nulo —un número que resulta no estar en coexistencia— se trata
 * como `refused`: Meta no va a mandar nada que leer, y dejarlo esperando
 * sería una cola que nunca termina.
 */
async function estadoDeMeta(cfg: ConfigDeZernio, zernioAccountId: string): Promise<EstadoDeMeta> {
  const salud = await llamarAZernio<{ coexistenceHistorySync?: { status?: string } | null }>(
    cfg,
    `/v1/accounts/${encodeURIComponent(zernioAccountId)}/health`,
  );
  const estado = salud?.coexistenceHistorySync?.status;
  if (
    estado === 'requested' ||
    estado === 'imported' ||
    estado === 'declined' ||
    estado === 'already_synced' ||
    estado === 'refused'
  ) {
    return estado;
  }
  return 'refused';
}

/** Los chats del inbox, mapeados a lo que el dominio sabe leer. */
async function chatsDelInbox(
  cfg: ConfigDeZernio,
  zernioAccountId: string,
): Promise<ChatParaAprender[]> {
  const r = await llamarAZernio<{ data?: ConversacionDeZernio[] }>(
    cfg,
    `/v1/inbox/conversations?accountId=${encodeURIComponent(zernioAccountId)}` +
      `&platform=whatsapp&sortOrder=desc&limit=${MAX_CHATS}`,
  );
  const conversaciones = Array.isArray(r?.data) ? r.data : [];
  const chats: ChatParaAprender[] = [];
  for (const conversacion of conversaciones) {
    // Los grupos no se leen (ADR-0039): se saltan ANTES de pedir sus
    // mensajes. Descartarlos después igual los habría traído a memoria.
    if (conversacion.isGroup === true) continue;
    const m = await llamarAZarnioMensajes(cfg, zernioAccountId, conversacion.id);
    // Solo el TEXTO, la dirección y la fecha: ni ids, ni nombres, ni teléfonos
    // — el resto del mensaje no ayuda a aprender y sí son datos de personas.
    chats.push({
      mensajes: m.map((msg) => ({
        texto: typeof msg.message === 'string' ? msg.message : null,
        delNegocio: msg.direction === 'outgoing',
        fecha: msg.createdAt,
      })),
    });
  }
  return chats;
}

async function llamarAZarnioMensajes(
  cfg: ConfigDeZernio,
  zernioAccountId: string,
  conversacionId: string,
): Promise<MensajeDeZernio[]> {
  const m = await llamarAZernio<{ messages?: MensajeDeZernio[] }>(
    cfg,
    `/v1/inbox/conversations/${encodeURIComponent(conversacionId)}/messages` +
      `?accountId=${encodeURIComponent(zernioAccountId)}&sortOrder=desc&limit=${MAX_MENSAJES_POR_CHAT}`,
  );
  return Array.isArray(m?.messages) ? m.messages : [];
}

/**
 * Corre el job. `deps` lo arma `main.ts`; en las pruebas van doblados.
 *
 * Los pasos, en orden y por una razón:
 *
 * 1. Autorización (arriba): sin ella, cero llamadas afuera.
 * 2. Qué dice Meta: `requested` reprograma el MISMO job; los rechazos cierran
 *    la corrida con su estado.
 * 3. Leer y aprender: los chats viven en memoria; el pedido al proveedor ya
 *    sale redactado por el dominio.
 * 4. Fuente + estado + aviso, en UNA transacción.
 */
export async function processAprender(
  pool: Pool,
  job: JobAprender,
  deps: {
    fetchImpl?: typeof fetch;
    /** Módulos que la corrida necesita además de `whatsapp` (ya la filtra la cola). */
    activo?: (modulo: string) => boolean;
  } = {},
): Promise<Record<string, unknown>> {
  const data = job.data;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const activo = deps.activo ?? (() => true);

  // 1. La autorización, antes de cualquier llamada afuera.
  const autorizacion = await autorizacionVigente(pool, data);
  if (!autorizacion) {
    return { terminado: 'sin autorización vigente' };
  }
  // Sin knowledge no hay dónde dejar lo aprendido ni pantalla que lo revise;
  // sin agents no hay camino al proveedor. El job se salta y la marca queda
  // esperando: lo decide el despliegue, no la cola.
  if (!activo('knowledge') || !activo('agents')) {
    return { skipped: true, reason: 'knowledge o agents apagados en este despliegue' };
  }
  const { account, historial } = autorizacion;
  const zernioAccountId = account.config.zernioAccountId;
  if (typeof zernioAccountId !== 'string' || !zernioAccountId) {
    await cerrarAparte(pool, data, autorizacion, 'refused');
    return { terminado: 'la cuenta no guarda su cuenta de Zernio' };
  }

  // 2. Qué dice Meta del historial.
  const cfg = await zernioDeLaCuenta(account, fetchImpl);
  const deMeta = await estadoDeMeta(cfg, zernioAccountId);
  if (deMeta === 'requested') {
    const desde = data.desde ? Date.parse(data.desde) : Date.now();
    if (Date.now() - desde > TOPE_DE_ESPERA_MS) {
      await cerrarAparte(pool, data, autorizacion, 'vencido');
      return { terminado: 'vencido', horas: TOPE_DE_ESPERA_MS / 3_600_000 };
    }
    await cerrarAparte(pool, data, autorizacion, 'requested');
    // El MISMO job se reprograma (patrón de la cola outbound con el
    // silencio): así no depende de que un jobId deduplicado deje pasar la
    // reprogramación.
    throw new EsperandoAMetaError(ESPERA_DE_META_MS);
  }
  if (deMeta !== 'imported') {
    // declined / already_synced / refused: la tarjeta de Canales explica cada
    // uno y qué hacer. Acá solo queda registrado en la cuenta.
    await cerrarAparte(pool, data, autorizacion, deMeta);
    return { terminado: deMeta };
  }

  // 3. Leer los chats y aprender. Todo lo que pasa por acá vive en memoria.
  const chats = await chatsDelInbox(cfg, zernioAccountId);
  return withTenant(pool, data.tenantId, async (client) => {
    const resultado = await aprenderDeLosChats(client, {
      tenantId: data.tenantId,
      chats,
      ...(data.requestId ? { requestId: data.requestId } : {}),
    });
    if (resultado.status === 'failed') {
      // El fallo se devuelve y no se lanza desde el módulo para que su acta
      // quede en la misma transacción; acá sí se lanza, porque el reintento
      // de la cola es la salida: el proveedor pudo toser un momento. La
      // transacción se revierte — ni fuente ni estado — y la corrida vuelve
      // a empezar desde la autorización, que sigue vigente.
      throw new Error(resultado.error);
    }
    if (resultado.status === 'sin_chats' || resultado.entradas.length === 0) {
      // No se crea una fuente vacía: el ADR manda la salida «no encontré
      // preguntas que se repitan», no una revisión sin nada que revisar.
      await cerrar(client, data, { account, historial }, 'sin_resultados');
      return { terminado: 'sin_resultados', chats: chats.length };
    }
    // 4. La fuente, el estado y el aviso, TODO en esta transacción: o queda
    // lo aprendido con su revisión pendiente, o no queda nada.
    const source = await crearFuenteAprendida(client, {
      tenantId: data.tenantId,
      tono: resultado.tono,
      entradas: resultado.entradas,
      ...(data.requestId ? { requestId: data.requestId } : {}),
    });
    await cerrar(client, data, { account, historial }, 'listo');
    await publishEvent(client, {
      name: 'whatsapp.historial_listo',
      tenantId: data.tenantId,
      payload: { channelAccountId: data.accountId, sourceId: source.id },
      actor: 'system',
      ...(data.requestId ? { requestId: data.requestId } : {}),
    });
    // Conteo, nunca contenido: el log dice cuánto se leyó, no qué se leyó.
    console.log(
      `aprender-de-chats: ${resultado.entradas.length} entradas de ${chats.length} chats ` +
        `en ${data.tenantId} (${resultado.provider}/${resultado.model}, ` +
        `${resultado.tokensIn + resultado.tokensOut} tokens) — fuente ${source.id} por revisar`,
    );
    return {
      terminado: 'listo',
      sourceId: source.id,
      entradas: resultado.entradas.length,
      chats: chats.length,
      ejecucion: resultado.executionId,
    };
  });
}
