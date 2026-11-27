import type { PoolClient } from 'pg';
import { writeAudit, type ActorKind } from '@iaxti/module-audit';
import { findAccountById, fijarHistorialDeChats, type ChannelAccountRef } from '@iaxti/module-channels';
import { baseDeZernio, llamarAZernio, type ConfigDeZernio } from './zernio-base';
import { credencialDeLaCuenta } from './webhook-secret';

/**
 * Autorizar que IAxTi lea los chats del negocio (#1406, ADR-0039).
 *
 * Regla 1 del ADR: se pregunta antes, y lo autoriza explícitamente un ADMIN
 * del negocio, por número. Sin esa marca el job no llama a Zernio; retirarla
 * corta el job pendiente — el job, al correr, vuelve a mirar la cuenta y si
 * no encuentra autorización vigente termina sin leer nada.
 *
 * Lo que la cuenta guarda es solo la marca y su avance (`config.historial`,
 * escrita por el módulo `channels`, dueño de la tabla); la auditoría de la
 * decisión va en la misma transacción, y el encolado del job lo pone quien
 * llama con la cola de workers.
 */

/** Un problema que tiene que leer una persona, con qué hacer. */
export class ErrorDeHistorial extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = 'ErrorDeHistorial';
  }
}

const MENSAJE_SIN_COEXISTENCIA =
  'Este número no está conectado en coexistencia: no hay historial que leer.';

/** Lo que Zernio puede contestar sobre el historial de un número. */
export type EstadoDeMeta =
  | 'requested'
  | 'imported'
  | 'declined'
  | 'already_synced'
  | 'refused';

/** La cuenta cargada, con lo que este camino exige de ella. */
async function cuentaExigida(
  client: PoolClient,
  input: { tenantId: string; accountId: string },
): Promise<ChannelAccountRef> {
  const account = await findAccountById(client, input.accountId);
  if (!account || account.tenantId !== input.tenantId) {
    throw new ErrorDeHistorial('No encontramos ese canal.');
  }
  if (account.kind !== 'whatsapp') {
    throw new ErrorDeHistorial('Ese canal no es de WhatsApp.');
  }
  if (account.provider !== 'zernio') {
    throw new ErrorDeHistorial('Ese canal no va por el proveedor que puede leer chats.');
  }
  if (account.state !== 'active') {
    throw new ErrorDeHistorial('Ese número no está activo: revisa su estado en Canales.');
  }
  return account;
}

/**
 * Autoriza la lectura y deja el job en camino.
 *
 * `encolar` lo inyecta quien llama (la API, con su cola de workers) y recibe
 * cuándo quedó autorizado: el `jobId` conviene amarrarlo a ese instante, para
 * que reautorizar después de retirar nazca un job nuevo y no choque con el
 * completado de la corrida anterior, que BullMQ sigue guardando.
 *
 * Se llama DESPUÉS de escribir la marca: si el COMMIT de la transacción
 * falla, el job corre igual, no encuentra autorización y termina sin llamar
 * a Zernio — la regla 1 no depende del orden de esas dos cosas.
 */
export async function autorizarAprendizajeDeChats(
  client: PoolClient,
  input: {
    tenantId: string;
    accountId: string;
    actor: string;
    actorKind: ActorKind;
    requestId?: string;
    /** Encola el job de workers; la cola la conoce quien llama. */
    encolar?: (marca: { autorizadoEl: string }) => Promise<void>;
  },
): Promise<{ account: ChannelAccountRef; autorizadoEl: string }> {
  const account = await cuentaExigida(client, input);
  if (account.config.coexistencia !== true) {
    // El historial existe SOLO en coexistencia (ADR-0039): un número que vive
    // solo para IAxTi no tiene chats anteriores acá. La pantalla lo dice
    // antes de ofrecer el botón; esto es la segunda cerradura.
    throw new ErrorDeHistorial(MENSAJE_SIN_COEXISTENCIA);
  }
  const autorizadoEl = new Date().toISOString();
  await fijarHistorialDeChats(client, {
    tenantId: input.tenantId,
    accountId: input.accountId,
    historial: {
      estado: 'esperando',
      autorizadoPor: input.actor,
      autorizadoEl,
    },
  });
  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: input.actor,
    actorKind: input.actorKind,
    action: 'whatsapp.historial.autorizado',
    resource: 'channel_account',
    resourceId: input.accountId,
    result: 'ok',
    metadata: { proveedor: account.provider },
    ...(input.requestId ? { requestId: input.requestId } : {}),
  });
  if (input.encolar) await input.encolar({ autorizadoEl });
  return { account, autorizadoEl };
}

/**
 * Retira la autorización.
 *
 * No llama a Zernio ni detiene nada afuera: quita la marca, y el job —si
 * tenía uno pendiente— la echa de menos al correr y termina. Es idempotente:
 * retirar lo que no estaba autorizado no es un error.
 */
export async function retirarAutorizacionDeChats(
  client: PoolClient,
  input: {
    tenantId: string;
    accountId: string;
    actor: string;
    actorKind: ActorKind;
    requestId?: string;
  },
): Promise<void> {
  const account = await findAccountById(client, input.accountId);
  if (!account || account.tenantId !== input.tenantId) {
    throw new ErrorDeHistorial('No encontramos ese canal.');
  }
  const tenia = account.config.historial ?? null;
  await fijarHistorialDeChats(client, {
    tenantId: input.tenantId,
    accountId: input.accountId,
    historial: null,
  });
  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: input.actor,
    actorKind: input.actorKind,
    action: 'whatsapp.historial.retirado',
    resource: 'channel_account',
    resourceId: input.accountId,
    // `tenia` es lo único que distingue retirar de deshacer una marca que ya
    // no estaba: sin él, la auditoría de las dos se ve idéntica.
    result: 'ok',
    metadata: { tenia: tenia !== null, estadoPrevio: (tenia as { estado?: string } | null)?.estado ?? null },
    ...(input.requestId ? { requestId: input.requestId } : {}),
  });
}

export interface EstadoDelHistorial {
  /** true si la cuenta nació en coexistencia (#1407): solo ahí hay historial. */
  coexistencia: boolean;
  /** La marca de la cuenta: qué autorizó el dueño y hasta dónde llegó el job. */
  historial: { estado: string; autorizadoPor: string; autorizadoEl: string } | null;
  /** Lo que Meta contestó por Zernio, si había algo que preguntar. */
  deMeta: EstadoDeMeta | null;
}

/**
 * El estado del historial para la pantalla: la marca de la cuenta y lo que
 * Meta dice de verdad.
 *
 * A Zernio se le pregunta con la LLAVE DEL NEGOCIO (`credencialDeLaCuenta`),
 * nunca la del operador: es el inbox del negocio lo que se está mirando. Y
 * solo se pregunta si la cuenta es de coexistencia — a un número que no
 * tiene historial no se le va a preguntar por uno.
 */
export async function estadoDelHistorial(
  client: PoolClient,
  input: {
    tenantId: string;
    accountId: string;
    /** Base y fetch de Zernio; por omisión el entorno y el fetch global. */
    zernio?: { apiBase?: string; fetchImpl?: typeof fetch };
  },
): Promise<EstadoDelHistorial> {
  const account = await findAccountById(client, input.accountId);
  if (!account || account.tenantId !== input.tenantId) {
    throw new ErrorDeHistorial('No encontramos ese canal.');
  }
  const coexistencia = account.config.coexistencia === true;
  const historial =
    account.config.historial && typeof account.config.historial === 'object'
      ? (account.config.historial as EstadoDelHistorial['historial'])
      : null;
  if (!coexistencia || account.kind !== 'whatsapp' || account.provider !== 'zernio') {
    return { coexistencia, historial, deMeta: null };
  }
  const zernioAccountId = account.config.zernioAccountId;
  if (typeof zernioAccountId !== 'string' || !zernioAccountId) {
    return { coexistencia, historial, deMeta: null };
  }
  const llave = await credencialDeLaCuenta(account);
  if (!llave) return { coexistencia, historial, deMeta: null };
  const cfg: ConfigDeZernio = {
    apiKey: llave,
    apiBase: baseDeZernio(input.zernio?.apiBase),
    fetchImpl: input.zernio?.fetchImpl ?? globalThis.fetch,
  };
  const salud = await llamarAZernio<{ coexistenceHistorySync?: { status?: string } | null }>(
    cfg,
    `/v1/accounts/${encodeURIComponent(zernioAccountId)}/health`,
  );
  const estado = salud?.coexistenceHistorySync?.status;
  return {
    coexistencia,
    historial,
    deMeta: typeof estado === 'string' ? (estado as EstadoDeMeta) : null,
  };
}
