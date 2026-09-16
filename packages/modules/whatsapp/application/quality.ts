import type { PoolClient } from 'pg';
import { publishEvent } from '@iaxti/core';
import { setChannelState } from '@iaxti/module-channels';

// Calidad del número (#45, SPEC §12): proteger el rating de Meta es
// proteger el canal de ventas del cliente. En rojo se PAUSAN los envíos
// iniciados por el negocio; las respuestas dentro de ventana siguen.

export type NumberQuality = 'green' | 'yellow' | 'red';

export interface QualityUpdate {
  phoneNumberId: string;
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

/** Los cambios de calidad/límite del webhook de Meta (#45). */
export function normalizeQualityUpdates(payload: unknown): QualityUpdate[] {
  const cuerpo = payload as { entry?: Array<{ changes?: MetaQualityChange[] }> };
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

/**
 * Aplica un cambio de calidad: sincroniza rating y límite, publica
 * `number.quality_changed`, y en ROJO pausa los envíos del negocio y
 * degrada el canal (la bandeja y el ADMIN lo ven al tiro).
 */
export async function applyQualityUpdate(
  client: PoolClient,
  input: { tenantId: string; update: QualityUpdate; requestId?: string },
): Promise<{ changed: boolean; pausado: boolean }> {
  const r = await client.query(
    'SELECT * FROM whatsapp_numbers WHERE tenant_id = $1 AND phone_number_id = $2 FOR UPDATE',
    [input.tenantId, input.update.phoneNumberId],
  );
  if (r.rowCount === 0) return { changed: false, pausado: false };
  const numero = r.rows[0];
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
