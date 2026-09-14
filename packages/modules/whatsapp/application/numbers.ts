import type { PoolClient } from 'pg';
import { createChannelAccount, setChannelState } from '@iaxti/module-channels';
import type { ChannelAccountRef } from '@iaxti/module-channels';

// WhatsAppNumber (#42): los ids de Meta en NUESTRA base. El número es del
// cliente; cuántos puede conectar lo dice su plan (plan_limits).

export interface WhatsAppNumber {
  id: string;
  tenantId: string;
  channelAccountId: string;
  phoneNumberId: string;
  wabaId: string | null;
  displayPhone: string | null;
  quality: 'green' | 'yellow' | 'red' | null;
  messagingLimit: string | null;
  connectedAt: Date | null;
  /** Pausa de envíos del negocio por calidad (#45); la levanta el ADMIN. */
  businessPausedAt: Date | null;
  pausedReason: string | null;
}

function rowToNumber(row: Record<string, unknown>): WhatsAppNumber {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    channelAccountId: row.channel_account_id as string,
    phoneNumberId: row.phone_number_id as string,
    wabaId: (row.waba_id as string) ?? null,
    displayPhone: (row.display_phone as string) ?? null,
    quality: (row.quality as WhatsAppNumber['quality']) ?? null,
    messagingLimit: (row.messaging_limit as string) ?? null,
    connectedAt: (row.connected_at as Date) ?? null,
    businessPausedAt: (row.business_paused_at as Date) ?? null,
    pausedReason: (row.paused_reason as string) ?? null,
  };
}

async function numerosPermitidos(client: PoolClient, tenantId: string): Promise<number> {
  const r = await client.query(
    `SELECT COALESCE(pl.whatsapp_numbers, 1) AS max
       FROM tenants t LEFT JOIN plan_limits pl ON pl.plan = t.plan
      WHERE t.id = $1`,
    [tenantId],
  );
  return r.rows[0]?.max ?? 1;
}

/**
 * El cierre del link de setup de Kapso: con los ids que devuelve se crea la
 * cuenta de canal (credencial POR REFERENCIA) y el número. Valida el tope
 * del plan ANTES de conectar.
 */
export async function connectWhatsAppNumber(
  client: PoolClient,
  input: {
    tenantId: string;
    name: string;
    phoneNumberId: string;
    wabaId?: string;
    displayPhone?: string;
    credentialRef: string;
    webhookSecretRef: string;
  },
): Promise<{ number: WhatsAppNumber; account: ChannelAccountRef }> {
  const existentes = await client.query(
    'SELECT count(*)::int AS n FROM whatsapp_numbers WHERE tenant_id = $1',
    [input.tenantId],
  );
  const max = await numerosPermitidos(client, input.tenantId);
  if (existentes.rows[0].n >= max) {
    throw new Error(
      `Tu plan permite ${max} número${max === 1 ? '' : 's'} de WhatsApp. Sube de plan para conectar otro.`,
    );
  }

  const account = await createChannelAccount(client, {
    tenantId: input.tenantId,
    kind: 'whatsapp',
    name: input.name,
    credentialRef: input.credentialRef,
    webhookSecretRef: input.webhookSecretRef,
    config: { phoneNumberId: input.phoneNumberId, wabaId: input.wabaId ?? null },
  });
  let row;
  try {
    const r = await client.query(
      `INSERT INTO whatsapp_numbers
         (tenant_id, channel_account_id, phone_number_id, waba_id, display_phone, connected_at)
       VALUES ($1, $2, $3, $4, $5, now()) RETURNING *`,
      [input.tenantId, account.id, input.phoneNumberId, input.wabaId ?? null, input.displayPhone ?? null],
    );
    row = r.rows[0];
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new Error('Ese número ya está conectado en IAxTi.');
    }
    throw err;
  }
  // Con webhook verificado el canal queda activo; #45 lo degrada por calidad.
  const activa = await setChannelState(client, {
    tenantId: input.tenantId,
    accountId: account.id,
    state: 'active',
  });
  return { number: rowToNumber(row), account: activa };
}

export async function listWhatsAppNumbers(
  client: PoolClient,
  tenantId: string,
): Promise<WhatsAppNumber[]> {
  const r = await client.query(
    'SELECT * FROM whatsapp_numbers WHERE tenant_id = $1 ORDER BY created_at',
    [tenantId],
  );
  return r.rows.map(rowToNumber);
}

/** El webhook trae phone_number_id: con esto se ubica tenant y cuenta. */
export async function findNumberByPhoneNumberId(
  client: PoolClient,
  phoneNumberId: string,
): Promise<WhatsAppNumber | null> {
  const r = await client.query('SELECT * FROM whatsapp_numbers WHERE phone_number_id = $1', [
    phoneNumberId,
  ]);
  return r.rowCount === 0 ? null : rowToNumber(r.rows[0]);
}
