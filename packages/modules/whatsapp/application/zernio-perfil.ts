import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { writeAudit } from '@iaxti/module-audit';
import { listChannelAccounts, proveedorDe, registerProvider } from '@iaxti/module-channels';
import type { ChannelAccountRef } from '@iaxti/module-channels';
import { createZernioProvider } from './zernio';
import { connectWhatsAppNumber } from './numbers';
import { ErrorDeZernio, llamarAZernio, type ConfigDeZernio } from './zernio-base';

/**
 * Un perfil de Zernio por tenant, y que el código no pueda cruzarlos (#1321).
 *
 * En Zernio todo cuelga de un PERFIL: las cuentas conectadas, sus bandejas y
 * sus webhooks. Si dos negocios comparten perfil, cada uno ve las
 * conversaciones del otro. Con una agencia eso es un mal rato; en un CRM
 * multi-tenant es filtrar los datos de un cliente a otro sin que ninguno haya
 * hecho nada mal.
 *
 * Medido en el OpenAPI de Zernio (v1.615, 15-11-2026), no recordado:
 *
 * - El perfil acepta `externalId`, **único por dueño**: un duplicado responde
 *   409 `profile_external_id_conflict`. Se usa el `tenant_id`, así que dos
 *   altas simultáneas del mismo tenant no pueden crear dos perfiles: la
 *   segunda choca y lee el de la primera.
 * - Un perfil **ya no tiene un solo lugar por plataforma**: conectar otra
 *   cuenta la AGREGA («reconnecting the SAME account keeps it»). El pisotón
 *   que sufrimos con ZernFlow (`inmobiliariasegura.cl` reemplazó a
 *   `agenciapalena`) era del modelo anterior. Para WhatsApp, además, conectar
 *   un número que ya está en otro perfil responde 409.
 * - Hay **llaves restringidas a perfiles** (`scope: 'profiles'`). Es lo que
 *   convierte el aislamiento en algo que hace cumplir el proveedor y no
 *   nuestra disciplina: con la llave del negocio A, Zernio no deja tocar
 *   nada del perfil de B aunque nuestro código se equivoque de id.
 * - Cada webhook trae `account.accountId`, `account.profileId` y
 *   `profiles[].externalId`. Es la verificación POR MENSAJE: un evento que no
 *   es de la cuenta destino no entra, aunque la firma calce.
 *
 * Y un techo que hay que saber: **50 webhooks por usuario**. Una suscripción
 * por cuenta (la que da URL y secreto propios a cada canal) llega hasta 50
 * canales de Zernio. Pasado eso hay que pasar a un webhook común que elige la
 * cuenta por `account.accountId` — y esta verificación es la que lo permite.
 */

/** Lo que trae cada evento de la bandeja de Zernio para saber de quién es. */
interface SobreDeZernio {
  test?: boolean;
  event?: string;
  account?: { id?: string; accountId?: string; profileId?: string };
  profiles?: Array<{ id?: string; externalId?: string | null }>;
}

/** La cuenta destino del webhook, tal como la conoce IAxTi. */
interface CuentaDeZernio {
  tenantId: string;
  config: Record<string, unknown>;
}

export type VeredictoDelEvento =
  | { ok: true }
  /** Una muestra de `POST /v1/webhooks/test`: prueba URL y secreto, no trae un mensaje. */
  | { ok: false; prueba: true }
  | { ok: false; prueba?: false; motivo: string };

/**
 * ¿Este evento es de ESTA cuenta y de ESTE tenant?
 *
 * Se exige todo, y que falte cualquier cosa es que no: es la única forma de
 * que un cambio de forma del lado de Zernio cierre la puerta en vez de
 * abrirla. Las tres comprobaciones no son redundantes:
 *
 * 1. `account.accountId` contra la cuenta guardada: que el mensaje sea del
 *    número al que apunta la URL.
 * 2. `account.profileId` contra el perfil guardado: que esa cuenta no se haya
 *    movido a otro perfil (`PATCH /v1/accounts/{id}` lo permite).
 * 3. `profiles[].externalId` contra el tenant: que el perfil sea de este
 *    negocio según Zernio, no según nuestra base. Es la que ataja una fila
 *    nuestra mal escrita.
 */
export function eventoDeZernioEsDeLaCuenta(payload: unknown, cuenta: CuentaDeZernio): VeredictoDelEvento {
  if (!payload || typeof payload !== 'object') return { ok: false, motivo: 'el evento no es un objeto' };
  const sobre = payload as SobreDeZernio;
  // Solo una petición con la firma de Zernio llega hasta acá, así que `test`
  // lo puso Zernio. Las muestras traen ids inventados: se reconocen antes de
  // compararlas, porque sirven para comprobar el webhook y no deben crear nada.
  // `POST /v1/webhooks/test` tiene dos modos y los dos son muestra: pedirlo
  // CON `event` manda una muestra de ese evento marcada con `test: true`
  // (spec v1.679, `WebhookPayloadMessage.test`), y pedirlo pelado manda el
  // payload `webhook.test` — sin cuenta y sin perfiles, porque solo dice
  // «URL y secreto andan» (`WebhookPayloadTest`). El pelado es el botón
  // «Probar» a secas del panel, y como no trae cuenta caía a la comparación
  // de abajo y respondíamos 404: la prueba del webhook quedaba fallida
  // aunque el webhook anduviera (medido el 19-11 contra el número real,
  // #1362).
  if (sobre.test === true || sobre.event === 'webhook.test') return { ok: false, prueba: true };

  const esperadaCuenta = cuenta.config.zernioAccountId;
  const esperadoPerfil = cuenta.config.zernioProfileId;
  if (typeof esperadaCuenta !== 'string' || !esperadaCuenta || typeof esperadoPerfil !== 'string' || !esperadoPerfil) {
    return { ok: false, motivo: 'la cuenta de IAxTi no guarda su cuenta y su perfil de Zernio' };
  }
  const cuentaDelEvento = sobre.account?.accountId ?? sobre.account?.id;
  if (cuentaDelEvento !== esperadaCuenta) return { ok: false, motivo: 'el evento es de otra cuenta de Zernio' };
  if (sobre.account?.profileId !== esperadoPerfil) return { ok: false, motivo: 'la cuenta está en otro perfil de Zernio' };

  const perfiles = Array.isArray(sobre.profiles) ? sobre.profiles : [];
  if (perfiles.length === 0) return { ok: false, motivo: 'el evento no dice de qué perfil es' };
  // TODOS los perfiles del evento tienen que ser de este tenant, no alguno:
  // un evento que pertenece también a otro negocio no es solo de este.
  if (!perfiles.some((p) => p.id === esperadoPerfil)) return { ok: false, motivo: 'el evento no es del perfil de esta cuenta' };
  if (!perfiles.every((p) => p.externalId === cuenta.tenantId)) {
    return { ok: false, motivo: 'el perfil del evento no es de este negocio' };
  }
  return { ok: true };
}

/** El perfil tal como lo devuelve Zernio (`Profile`, spec v1.615). */
export interface PerfilDeZernio {
  _id: string;
  name: string;
  externalId?: string | null;
}

/** Un problema del alta que tiene que leer una persona, con qué hacer. */
export class ErrorDelAlta extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = 'ErrorDelAlta';
  }
}

async function perfilesConExternalId(cfg: ConfigDeZernio, tenantId: string): Promise<PerfilDeZernio[]> {
  const r = await llamarAZernio<{ profiles?: PerfilDeZernio[] }>(
    cfg,
    `/v1/profiles?externalId=${encodeURIComponent(tenantId)}&includeOverLimit=true`,
  );
  // Filtrado acá también: si Zernio ignorara el parámetro, devolvería TODOS
  // los perfiles, y tomar el primero sería darle a este tenant el de otro.
  return (r.profiles ?? []).filter((p) => p.externalId === tenantId);
}

function unico(perfiles: PerfilDeZernio[], tenantId: string): PerfilDeZernio | null {
  if (perfiles.length > 1) {
    // Pasa si dos miembros del equipo de Zernio crearon cada uno el suyo: el
    // `externalId` es único por dueño, no por equipo. Elegir uno sería
    // adivinar dónde están las conversaciones del negocio.
    throw new ErrorDelAlta(
      `Hay ${perfiles.length} perfiles de Zernio para el negocio ${tenantId} (${perfiles.map((p) => p._id).join(', ')}). ` +
        'Deja uno solo en Zernio antes de conectar.',
    );
  }
  return perfiles[0] ?? null;
}

/**
 * El perfil del tenant: el que existe, o uno nuevo.
 *
 * Primero se busca por `externalId`; si no hay, se crea con una
 * `Idempotency-Key` derivada del tenant. Dos altas simultáneas no pueden
 * dejar dos perfiles: la segunda recibe 409 (`externalId` ocupado, o la
 * llave todavía en proceso) y vuelve a buscar.
 */
export async function perfilDelTenant(
  cfg: ConfigDeZernio,
  input: { tenantId: string; nombre: string },
): Promise<{ perfil: PerfilDeZernio; creado: boolean }> {
  const existente = unico(await perfilesConExternalId(cfg, input.tenantId), input.tenantId);
  if (existente) return { perfil: existente, creado: false };
  try {
    const r = await llamarAZernio<{ profile?: PerfilDeZernio }>(cfg, '/v1/profiles', {
      method: 'POST',
      idempotencyKey: `iaxti-perfil-${input.tenantId}`,
      body: {
        // El nombre también es único en el equipo: con el pedazo del id, dos
        // negocios que se llaman igual no chocan.
        name: `${input.nombre.trim().slice(0, 60)} · ${input.tenantId.slice(0, 8)}`,
        externalId: input.tenantId,
        description: `IAxTi tenant ${input.tenantId}`,
        timezone: 'America/Santiago',
      },
    });
    const perfil = r.profile;
    if (!perfil?._id || perfil.externalId !== input.tenantId) {
      throw new ErrorDelAlta('Zernio creó el perfil pero no devolvió su id con el externalId de este negocio.');
    }
    return { perfil, creado: true };
  } catch (e) {
    if (!(e instanceof ErrorDeZernio) || e.status !== 409) throw e;
    const otro = unico(await perfilesConExternalId(cfg, input.tenantId), input.tenantId);
    if (otro) return { perfil: otro, creado: false };
    // 409 por NOMBRE con otro externalId: ese perfil es de alguien más.
    throw new ErrorDelAlta(
      `Zernio rechazó el perfil (${e.code ?? '409'}) y no hay ninguno con el externalId ${input.tenantId}. ` +
        'Probablemente el nombre lo usa el perfil de otro negocio: revisa en Zernio.',
    );
  }
}

/** Una cuenta conectada tal como la lista Zernio (`ListedAccount`). */
interface CuentaListada {
  _id: string;
  platform?: string;
  profileId?: string | { _id?: string };
  username?: string;
  displayName?: string;
  isActive?: boolean;
  needsReconnection?: boolean;
}

function perfilDe(c: CuentaListada): string | undefined {
  return typeof c.profileId === 'string' ? c.profileId : c.profileId?._id;
}

async function cuentasDelPerfil(cfg: ConfigDeZernio, profileId: string): Promise<CuentaListada[]> {
  const r = await llamarAZernio<{ accounts?: CuentaListada[] }>(
    cfg,
    `/v1/accounts?profileId=${encodeURIComponent(profileId)}&includeOverLimit=true`,
  );
  // Mismo cuidado que con los perfiles: no se confía en que el filtro se
  // haya aplicado, se comprueba cada una.
  return (r.accounts ?? []).filter((c) => perfilDe(c) === profileId);
}

/**
 * La cuenta de Zernio que se va a dar de alta, comprobada contra el perfil
 * del tenant.
 *
 * Es el criterio 1 de #1321 hecho código: una cuenta que no está en el perfil
 * de ESTE tenant no se da de alta, la pida quien la pida. El id lo escribe
 * una persona al conectar, y un id copiado de la fila equivocada era
 * justamente el error que no se veía en ninguna prueba.
 */
export async function cuentaDelPerfil(
  cfg: ConfigDeZernio,
  input: { profileId: string; zernioAccountId: string; plataforma: string },
): Promise<CuentaListada> {
  const cuentas = await cuentasDelPerfil(cfg, input.profileId);
  const suya = cuentas.find((c) => c._id === input.zernioAccountId);
  if (!suya) {
    throw new ErrorDelAlta(
      `La cuenta ${input.zernioAccountId} no está en el perfil de este negocio. ` +
        'Conéctala desde el enlace que da este script, que la deja en el perfil correcto.',
    );
  }
  if (suya.platform !== input.plataforma) {
    throw new ErrorDelAlta(`La cuenta ${input.zernioAccountId} es de ${suya.platform ?? 'otra plataforma'}, no de ${input.plataforma}.`);
  }
  return suya;
}

/** Las cuentas del perfil, para mirar antes de tocar nada. */
export async function listarCuentasDelPerfil(cfg: ConfigDeZernio, profileId: string): Promise<CuentaListada[]> {
  return cuentasDelPerfil(cfg, profileId);
}

/**
 * ¿La cuenta sigue viva en SU perfil? Para el diagnóstico del canal (#591).
 *
 * `null` es «no se pudo preguntar», nunca «no existe»: confundirlas era lo
 * que dejaba el diagnóstico en verde sin que saliera un mensaje.
 */
export async function cuentaEnZernio(
  cfg: ConfigDeZernio,
  input: { profileId: string; zernioAccountId: string },
): Promise<{ existe: boolean; canales: string[] } | null> {
  try {
    const cuentas = await cuentasDelPerfil(cfg, input.profileId);
    const suya = cuentas.find((c) => c._id === input.zernioAccountId);
    if (!suya) return { existe: false, canales: [] };
    const viva = suya.isActive !== false && suya.needsReconnection !== true;
    return { existe: true, canales: viva && suya.platform ? [suya.platform] : [] };
  } catch {
    return null;
  }
}

/**
 * Lo que la llave del negocio NO necesita. Son grupos de Zernio
 * (`x-resource-group`): mandar y leer la bandeja es `messages`, y las
 * plantillas y la cuenta son `accounts`. Los webhooks quedan fuera a
 * propósito: los administra la llave del operador, y una llave del negocio
 * filtrada no tiene que poder redirigir sus mensajes a otra URL.
 */
const GRUPOS_QUE_NO_USA = [
  'publishing',
  'analytics',
  'ads',
  'telephony',
  'billing',
  'webhooks',
  'commerce',
  'creator_campaigns',
  'money',
  'calendar',
] as const;

/**
 * La llave del negocio: solo ve SU perfil.
 *
 * Zernio la devuelve una vez. Se crea con la llave del operador (una llave
 * restringida no puede crear llaves) y se comprueba antes de entregarla: con
 * ella, `GET /v1/profiles` tiene que mostrar ese perfil y ninguno más. Si la
 * restricción no se aplicó, la llave no sale de acá.
 */
export async function llaveDelTenant(
  cfg: ConfigDeZernio,
  input: { tenantId: string; profileId: string },
): Promise<{ llave: string; id: string }> {
  // `profileIds` llega como objetos `{_id, …}` y no como strings — medido el
  // 18-11 contra la API real: con la comparación a secas la llave nueva nunca
  // pasaba la comprobación, se borraba a sí misma y el alta no terminaba.
  const r = await llamarAZernio<{
    apiKey?: { id?: string; key?: string; scope?: string; profileIds?: Array<string | { _id?: string }> };
  }>(
    cfg,
    '/v1/api-keys',
    {
      method: 'POST',
      body: {
        name: `iaxti-${input.tenantId.slice(0, 8)}`,
        scope: 'profiles',
        profileIds: [input.profileId],
        permission: 'read-write',
        disabledResourceGroups: GRUPOS_QUE_NO_USA,
      },
    },
  );
  const k = r.apiKey;
  if (!k?.key || !k.id) throw new ErrorDelAlta('Zernio no devolvió la llave nueva.');
  const idsDePerfil = (k.profileIds ?? [])
    .map((p) => (typeof p === 'string' ? p : p?._id))
    .filter((x): x is string => Boolean(x));
  const restringida = k.scope === 'profiles' && idsDePerfil.length === 1 && idsDePerfil[0] === input.profileId;
  const visto = restringida
    ? await llamarAZernio<{ profiles?: PerfilDeZernio[] }>({ ...cfg, apiKey: k.key }, '/v1/profiles').catch(() => null)
    : null;
  const ids = (visto?.profiles ?? []).map((p) => p._id);
  if (!restringida || ids.length !== 1 || ids[0] !== input.profileId) {
    // Se borra: una llave que ve más de lo que debe no puede quedar viva.
    await llamarAZernio(cfg, `/v1/api-keys/${encodeURIComponent(k.id)}`, { method: 'DELETE' }).catch(() => undefined);
    throw new ErrorDelAlta(
      `La llave nueva no quedó restringida al perfil ${input.profileId} (ve: ${ids.join(', ') || 'nada'}). Se borró.`,
    );
  }
  return { llave: k.key, id: k.id };
}

interface WebhookDeZernio {
  _id: string;
  url: string;
}

/** Lo que hoy entiende el camino de entrada. Lo demás se suscribe cuando tenga quien lo lea. */
const EVENTOS = ['message.received'] as const;

/**
 * El webhook de la cuenta, atado a su perfil y a su cuenta.
 *
 * `profileIds` y `accountIds` hacen que Zernio entregue a esta URL solo los
 * eventos de este número: es la primera barrera, del lado del proveedor. La
 * segunda es `eventoDeZernioEsDeLaCuenta`, del nuestro.
 *
 * Si ya hay un webhook a esta misma URL se actualiza en vez de crear otro:
 * correr el alta dos veces no puede dejar dos suscripciones que entregan
 * cada mensaje dos veces. El secreto es siempre nuevo y se devuelve una vez.
 */
export async function suscribirWebhook(
  cfg: ConfigDeZernio,
  input: { url: string; profileId: string; zernioAccountId: string },
): Promise<{ id: string; secreto: string; creado: boolean }> {
  const secreto = randomBytes(32).toString('hex');
  const cuerpo = {
    name: `iaxti-${input.zernioAccountId.slice(-12)}`,
    url: input.url,
    secret: secreto,
    events: EVENTOS,
    isActive: true,
    profileIds: [input.profileId],
    accountIds: [input.zernioAccountId],
  };
  const lista = await llamarAZernio<{ webhooks?: WebhookDeZernio[] }>(cfg, '/v1/webhooks/settings');
  const existente = (lista.webhooks ?? []).find((w) => w.url === input.url);
  if (existente) {
    await llamarAZernio(cfg, '/v1/webhooks/settings', { method: 'PUT', body: { webhookId: existente._id, ...cuerpo } });
    return { id: existente._id, secreto, creado: false };
  }
  const r = await llamarAZernio<{ webhook?: WebhookDeZernio }>(cfg, '/v1/webhooks/settings', { method: 'POST', body: cuerpo });
  if (!r.webhook?._id) throw new ErrorDelAlta('Zernio no devolvió el webhook creado.');
  return { id: r.webhook._id, secreto, creado: true };
}

/**
 * El enlace para que el negocio conecte su número EN SU perfil.
 *
 * La página es de Zernio y abre el Embedded Signup de Meta. Conectar desde
 * acá y no desde el panel de Zernio es lo que asegura que el número cae en el
 * perfil del tenant y no en el que esté abierto en ese momento.
 *
 * `modo` (spec v1.679): sin él el popup abre en «coexistence», que es para
 * números que viven en la app WhatsApp Business del negocio —la app del
 * teléfono comparte el número con la Cloud API—. `api` es el otro caso: un
 * número que solo vive en la Cloud API de otro proveedor, sin la app encima,
 * y muestra el selector de WABA y número de Meta. Declararlo a mano, en
 * cualquier caso, deja el intento escrito en el enlace.
 *
 * `numeroEsperado` fija el número (E.164): si en el popup se elige otro, la
 * página termina con 409 `NUMBER_MISMATCH` y no se conecta nada. El tope vive
 * en el token de conexión del lado de Zernio, no en la URL.
 */
export async function enlaceParaConectar(
  cfg: ConfigDeZernio,
  input: {
    profileId: string;
    redirectUrl?: string;
    modo?: 'api' | 'business_app';
    numeroEsperado?: string;
  },
): Promise<string> {
  const q = new URLSearchParams({
    profileId: input.profileId,
    signup: 'hosted',
    language: 'es',
    brandName: 'IAxTi',
    ...(input.modo ? { onboarding: input.modo } : {}),
    ...(input.numeroEsperado ? { expectedPhoneNumber: input.numeroEsperado } : {}),
    ...(input.redirectUrl ? { redirect_url: input.redirectUrl } : {}),
  });
  const r = await llamarAZernio<{ authUrl?: string }>(cfg, `/v1/connect/whatsapp?${q.toString()}`);
  if (!r.authUrl) throw new ErrorDelAlta('Zernio no devolvió el enlace para conectar.');
  return r.authUrl;
}

/** El prefijo del emisor de una cuenta de Zernio en `channel_senders`. */
export const PREFIJO_EMISOR_ZERNIO = 'zernio:';

/**
 * Da de alta en IAxTi una cuenta de WhatsApp de Zernio ya comprobada contra
 * el perfil del tenant (`cuentaDelPerfil`).
 *
 * Pasa por `connectWhatsAppNumber` y no por un INSERT propio: ahí viven el
 * candado por tenant, el tope del plan, el número único y la reserva del
 * emisor. Esa reserva es la barrera ENTRE negocios: `channel_senders` tiene el
 * emisor como clave primaria global, así que la misma cuenta de Zernio no
 * puede quedar en dos tenants aunque los dos lo intenten a la vez. El emisor
 * es `zernio:<id>` para que nunca choque con un emisor de Zavu.
 */
export async function darDeAltaCuentaDeZernio(
  client: PoolClient,
  input: {
    tenantId: string;
    nombre: string;
    zernioAccountId: string;
    zernioProfileId: string;
    displayPhone?: string;
    credentialRef: string;
    webhookSecretRef: string;
    enviosReales?: boolean;
    actor?: string;
  },
): Promise<{ account: ChannelAccountRef }> {
  const { account } = await connectWhatsAppNumber(client, {
    tenantId: input.tenantId,
    name: input.nombre,
    senderId: `${PREFIJO_EMISOR_ZERNIO}${input.zernioAccountId}`,
    displayPhone: input.displayPhone,
    credentialRef: input.credentialRef,
    webhookSecretRef: input.webhookSecretRef,
    enviosReales: input.enviosReales,
    provider: 'zernio',
    configDelProveedor: { zernioAccountId: input.zernioAccountId, zernioProfileId: input.zernioProfileId },
  });
  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: input.actor ?? 'system',
    actorKind: 'system',
    action: 'channel.zernio.connected',
    resource: 'channel_account',
    resourceId: account.id,
    result: 'ok',
    metadata: { zernioAccountId: input.zernioAccountId, zernioProfileId: input.zernioProfileId },
  });
  return { account };
}

/**
 * La cuenta de IAxTi que ya da de alta esa cuenta de Zernio en este tenant,
 * si hay. Para que correr el alta dos veces no deje dos canales.
 */
export async function cuentaDeZernioYaConectada(
  client: PoolClient,
  tenantId: string,
  zernioAccountId: string,
): Promise<ChannelAccountRef | null> {
  const cuentas = await listChannelAccounts(client, tenantId);
  return (
    cuentas.find(
      (a) => a.provider === 'zernio' && a.config.zernioAccountId === zernioAccountId && a.state !== 'disconnected',
    ) ?? null
  );
}

/** Registra el adaptador de Zernio en este proceso si no estaba (scripts). */
export function asegurarAdaptadorDeZernio(): void {
  if (!proveedorDe({ kind: 'whatsapp', provider: 'zernio' })) registerProvider(createZernioProvider('whatsapp'));
}
