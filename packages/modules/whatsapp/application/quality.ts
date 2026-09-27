import type { PoolClient } from 'pg';
import { publishEvent } from '@iaxti/core';
import { setChannelState } from '@iaxti/module-channels';

// Calidad del número (#45, SPEC §12): proteger el rating de Meta es
// proteger el canal de ventas del cliente. En rojo se PAUSAN los envíos
// iniciados por el negocio; las respuestas dentro de ventana siguen.

export type NumberQuality = 'green' | 'yellow' | 'red';

/**
 * Un cambio de calidad ya traducido a NUESTRO vocabulario.
 *
 * La identidad del número es el `senderId` de Zavu (ADR-0014): es lo único que
 * el proveedor nos da y lo único que `conectarSender` guarda. `phoneNumberId`
 * —el id de Meta— queda NULL en toda cuenta conectada por Zavu; solo aparece en
 * filas antiguas de Meta directo y el día del proveedor propio (#82).
 *
 * Los dos son opcionales porque según de dónde venga el aviso llega uno o el
 * otro, pero tiene que venir UNO: sin identidad no hay número que actualizar.
 * Antes este campo era `phoneNumberId: string` obligatorio, y eso escondía el
 * problema: el tipo prometía una identidad que en la práctica era `undefined`.
 */
export interface QualityUpdate {
  senderId?: string;
  phoneNumberId?: string;
  quality?: NumberQuality;
  messagingLimit?: string;
}

interface MetaQualityChange {
  field?: string;
  value?: {
    metadata?: { phone_number_id?: string };
    phone_number_id?: string;
    display_phone_number?: string;
    event?: string; // FLAGGED | WARNED | UNFLAGGED | UPGRADE | DOWNGRADE | …
    current_limit?: string;
    quality_score?: { score?: string };
  };
}

const CALIDAD_POR_EVENTO: Record<string, NumberQuality> = {
  FLAGGED: 'red',
  RESTRICTED: 'red',
  WARNED: 'yellow',
  UNFLAGGED: 'green',
  VERIFIED: 'green',
};

/**
 * El sobre de Zavu: `{id, type, timestamp, senderId, projectId, data}`. Lo
 * específico de cada evento vive en `data` y NUNCA en `entry[].changes[]`.
 */
interface SobreZavu {
  type?: string;
  senderId?: string;
  data?: Record<string, unknown>;
}

/**
 * ¿Es el sobre de Zavu y no el webhook crudo de la Cloud API de Meta?
 *
 * Se distingue por forma, que es lo único que tenemos en el momento de leer:
 * Meta manda `entry[]` y Zavu manda `type` + `data`. Un sobre de Zavu no tiene
 * `entry`, y por eso el parser de Meta devolvía [] sobre él sin quejarse.
 */
function esSobreZavu(payload: unknown): payload is SobreZavu {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return !Array.isArray(p.entry) && (typeof p.type === 'string' || 'data' in p);
}

/**
 * Los cambios de calidad/límite que trae un webhook (#45).
 *
 * POR QUÉ ESTO NO ERA UNA FUNCIÓN SINO UN ADORNO: hasta este fix leía
 * `payload.entry[].changes[]` con `field === 'phone_number_quality_update'`,
 * que es el webhook CRUDO de la Cloud API de Meta. Pero lo que llega a
 * `/webhooks/channels/:accountId` desde #42 es el SOBRE DE ZAVU, que no tiene
 * `entry`: la función devolvía lista vacía SIEMPRE, sin error que lo delatara,
 * y todo el freno del #45 —«en rojo se pausa lo del negocio»— quedaba inerte
 * mientras Meta bajaba el número de la pyme a rojo.
 *
 * Ahora se decide por forma y cada rama dice la verdad sobre lo que puede leer.
 */
export function normalizeQualityUpdates(payload: unknown): QualityUpdate[] {
  if (esSobreZavu(payload)) {
    // Zavu HOY no publica ningún evento de calidad de número: su catálogo
    // (skill webhook-setup) va de `message.*` y `conversation.new` a
    // `broadcast.status_changed`, `template.status_changed`,
    // `invitation.status_changed` y `domain.*`, y nada sobre el rating del
    // número. Es coherente con ADR-0014: el `phone_number_quality_update` de
    // Meta llega a la app de Zavu, no a la nuestra.
    //
    // Así que acá no hay formato que leer, y adivinar los nombres de campo de
    // un evento que no existe sería peor que no tenerlo: se vería probado y
    // seguiría sin funcionar. La rama queda explícita —vacío A PROPÓSITO, no
    // por descuido— y la pregunta (¿cómo nos enteramos de la calidad con Zavu
    // en medio?) va al dueño del producto. Mientras no se responda, el freno
    // se activa a mano: `applyQualityUpdate` ya ubica el número por `senderId`.
    return [];
  }
  // Webhook crudo de la Cloud API de Meta: identidad por `phone_number_id`.
  // No llega por ninguna cuenta de hoy (todas las de WhatsApp son de Zavu) y
  // se conserva probado para el proveedor propio (#82) y para cualquier número
  // de los antiguos, que sí tienen `phone_number_id` en la base.
  const cuerpo = (payload ?? {}) as { entry?: Array<{ changes?: MetaQualityChange[] }> };
  const out: QualityUpdate[] = [];
  for (const entry of cuerpo.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'phone_number_quality_update') continue;
      const v = change.value ?? {};
      const phoneNumberId = v.phone_number_id ?? v.metadata?.phone_number_id;
      if (!phoneNumberId) continue;
      const score = v.quality_score?.score?.toLowerCase();
      const quality =
        score === 'green' || score === 'yellow' || score === 'red'
          ? (score as NumberQuality)
          : v.event
            ? CALIDAD_POR_EVENTO[v.event.toUpperCase()]
            : undefined;
      out.push({ phoneNumberId, quality, messagingLimit: v.current_limit });
    }
  }
  return out;
}

/** Lo que este caso de uso necesita de la fila; el resto no se mira. */
interface FilaNumero {
  id: string;
  sender_id: string | null;
  phone_number_id: string | null;
  channel_account_id: string;
  quality: NumberQuality | null;
  messaging_limit: string | null;
  business_paused_at: Date | null;
}

/**
 * Ubica el número del que habla el aviso, y en ESTE orden.
 *
 * POR QUÉ EL ORDEN IMPORTA: la consulta buscaba solo por `phone_number_id`, y
 * esa columna es NULL en todo número conectado por Zavu —`conectarSender` no la
 * llena porque el proveedor no expone los ids de Meta (ADR-0014)—. Así que la
 * consulta no encontraba fila NUNCA y `applyQualityUpdate` salía en silencio
 * con `changed: false`: aunque el aviso llegara bien parseado, la pausa del #45
 * no se aplicaba. La identidad real hoy es `sender_id`, que sí guardamos.
 *
 * El `phone_number_id` queda de respaldo, no de adorno: las filas antiguas de
 * Meta directo lo tienen y el proveedor propio (#82) lo va a volver a usar.
 */
async function buscarNumero(
  client: PoolClient,
  tenantId: string,
  update: QualityUpdate,
): Promise<FilaNumero | null> {
  if (!update.senderId && !update.phoneNumberId) {
    throw new Error(
      'Este cambio de calidad no dice de qué número habla (sin senderId ni phoneNumberId), ' +
        'así que no lo aplicamos. Revisa quién lo encoló antes de reintentar.',
    );
  }
  if (update.senderId) {
    const r = await client.query<FilaNumero>(
      'SELECT * FROM whatsapp_numbers WHERE tenant_id = $1 AND sender_id = $2 FOR UPDATE',
      [tenantId, update.senderId],
    );
    if ((r.rowCount ?? 0) > 0) return r.rows[0];
  }
  if (update.phoneNumberId) {
    const r = await client.query<FilaNumero>(
      'SELECT * FROM whatsapp_numbers WHERE tenant_id = $1 AND phone_number_id = $2 FOR UPDATE',
      [tenantId, update.phoneNumberId],
    );
    if ((r.rowCount ?? 0) > 0) return r.rows[0];
  }
  return null;
}

/**
 * Aplica un cambio de calidad: sincroniza rating y límite, publica
 * `number.quality_changed`, y en ROJO pausa los envíos del negocio y
 * degrada el canal (la bandeja y el ADMIN lo ven al tiro).
 */
export async function applyQualityUpdate(
  client: PoolClient,
  input: { tenantId: string; update: QualityUpdate; requestId?: string },
): Promise<{ changed: boolean; pausado: boolean }> {
  const numero = await buscarNumero(client, input.tenantId, input.update);
  if (!numero) return { changed: false, pausado: false };
  const calidadNueva = input.update.quality ?? numero.quality;
  const limiteNuevo = input.update.messagingLimit ?? numero.messaging_limit;
  if (calidadNueva === numero.quality && limiteNuevo === numero.messaging_limit) {
    return { changed: false, pausado: Boolean(numero.business_paused_at) };
  }

  const cayoARojo = calidadNueva === 'red' && numero.quality !== 'red';
  await client.query(
    `UPDATE whatsapp_numbers SET
       quality = $3,
       messaging_limit = $4,
       business_paused_at = CASE WHEN $5 THEN now() ELSE business_paused_at END,
       paused_reason = CASE WHEN $5
         THEN 'Meta bajó la calidad del número a rojo: pausamos los envíos del negocio para protegerlo.'
         ELSE paused_reason END,
       updated_at = now()
     WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, numero.id, calidadNueva ?? null, limiteNuevo ?? null, cayoARojo],
  );
  await publishEvent(client, {
    name: 'number.quality_changed',
    tenantId: input.tenantId,
    payload: {
      numberId: numero.id,
      // Van los dos identificadores: con Zavu el de Meta es null, y quien lea
      // este evento en un año necesita saber por cuál se ubicó el número.
      senderId: numero.sender_id,
      phoneNumberId: numero.phone_number_id,
      from: numero.quality,
      to: calidadNueva,
      messagingLimit: limiteNuevo,
      paused: cayoARojo || Boolean(numero.business_paused_at),
    },
    actor: 'system',
    requestId: input.requestId,
  });
  if (cayoARojo) {
    // El canal queda degraded: la pantalla de canales lo explica y el
    // evento channel.degraded avisa al ADMIN (notifications, F3).
    await setChannelState(client, {
      tenantId: input.tenantId,
      accountId: numero.channel_account_id,
      state: 'degraded',
      reason: 'calidad del número en rojo',
      requestId: input.requestId,
    }).catch(() => {}); // si ya estaba degraded/disconnected, no es error
  }
  return { changed: true, pausado: cayoARojo || Boolean(numero.business_paused_at) };
}

/** ¿Los envíos del negocio están pausados para esta cuenta de canal? */
export async function isBusinessPaused(
  client: PoolClient,
  tenantId: string,
  channelAccountId: string,
): Promise<string | null> {
  const r = await client.query(
    `SELECT paused_reason FROM whatsapp_numbers
      WHERE tenant_id = $1 AND channel_account_id = $2 AND business_paused_at IS NOT NULL`,
    [tenantId, channelAccountId],
  );
  return r.rowCount === 0 ? null : (r.rows[0].paused_reason as string) ?? 'Envíos del negocio pausados.';
}

/**
 * Al volver a yellow/green NADA se dispara solo: el ADMIN reactiva aquí.
 * Reactivar con la calidad aún en rojo se rechaza con explicación.
 */
export async function resumeBusinessSends(
  client: PoolClient,
  input: { tenantId: string; numberId: string; requestId?: string },
): Promise<void> {
  const r = await client.query(
    'SELECT * FROM whatsapp_numbers WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
    [input.tenantId, input.numberId],
  );
  if (r.rowCount === 0) throw new Error('No encontramos ese número.');
  const numero = r.rows[0];
  if (numero.quality === 'red') {
    throw new Error('La calidad sigue en rojo: espera a que Meta la recupere antes de reactivar.');
  }
  await client.query(
    `UPDATE whatsapp_numbers SET business_paused_at = NULL, paused_reason = NULL, updated_at = now()
     WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.numberId],
  );
  await setChannelState(client, {
    tenantId: input.tenantId,
    accountId: numero.channel_account_id,
    state: 'active',
    reason: 'el ADMIN reactivó los envíos',
    requestId: input.requestId,
  }).catch(() => {});
}

/**
 * ¿Hay algún número del negocio en calidad ROJA? (#75)
 *
 * Una campaña sale por el número del negocio, y mandarle promoción a mil
 * personas desde un número que Meta ya está mirando es la forma más corta de
 * perderlo. Esto se consulta ANTES de empezar, no mensaje por mensaje: para
 * eso ya está la pausa por calidad en la cola.
 */
export async function numeroEnRojo(client: PoolClient, tenantId: string): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM whatsapp_numbers WHERE tenant_id = $1 AND quality = 'red' LIMIT 1`,
    [tenantId],
  );
  return (r.rowCount ?? 0) > 0;
}
