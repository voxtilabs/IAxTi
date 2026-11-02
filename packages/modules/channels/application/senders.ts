import type { PoolClient } from 'pg';
import { findAccountById, getChannelAccount } from './accounts';
import type { ChannelKind } from '../domain/port';
import { writeAudit, type ActorKind } from '@iaxti/module-audit';

/** Solo se llama tras acreditar el emisor: CLI operador o callback autenticado. */
export async function reservarEmisor(
  client: PoolClient,
  input: { tenantId: string; senderId: string; accountId: string; actor?: string; actorKind?: ActorKind; requestId?: string },
): Promise<{ webhookAccountId: string; primeraConexion: boolean }> {
  const cuenta = await getChannelAccount(client, input.tenantId, input.accountId);
  if (cuenta.config.senderId !== input.senderId) throw new Error('El emisor no corresponde a esta cuenta.');
  await client.query(
    `INSERT INTO channel_senders (sender_id, tenant_id, webhook_account_id)
     VALUES ($1, $2, $3) ON CONFLICT (sender_id) DO NOTHING`,
    [input.senderId, input.tenantId, input.accountId],
  );
  // El PK global serializa incluso dos altas que todavía no se ven por RLS.
  const reserva = await client.query<{ webhook_account_id: string | null }>(
    `SELECT webhook_account_id FROM channel_senders
     WHERE sender_id = $1 AND tenant_id = $2 FOR UPDATE`,
    [input.senderId, input.tenantId],
  );
  if (!reserva.rows[0]) throw new Error('Ese emisor pertenece a otro negocio.');
  const webhookAccountId = reserva.rows[0].webhook_account_id;
  if (!webhookAccountId) throw new Error('Este emisor histórico tiene varias cuentas. Su receptor debe ser comprobado antes de añadir otra conexión.');
  const primaria = await getChannelAccount(client, input.tenantId, webhookAccountId);
  /**
   * Un receptor DESCONECTADO no manda sobre una conexión nueva (#1190).
   *
   * La reserva dice quién recibe los webhooks de este emisor, y su dueño le
   * impone sus referencias a cualquier canal que se sume. Eso es correcto
   * mientras ese dueño esté vivo: un emisor tiene un solo receptor y un solo
   * secreto, y relajarlo partiría la entrada.
   *
   * Pero un canal `disconnected` no recibe nada, y seguía dictando. Medido en
   * staging el 02-11: el canal `2210485b` estaba desconectado con
   * `webhook_secret_ref=ZAVU_WEBHOOK_SECRET`, y el flujo de invitación crea el
   * suyo con `ZAVU_PARTNER_PENDING` —su marcador de «todavía no custodié el
   * secreto»—, así que la comparación de abajo lanzaba SIEMPRE. No era una
   * carrera: un número que alguna vez se conectó a mano no se podía reconectar
   * por invitación nunca, y el `catch` del barrido lo mostraba como
   * `PARTNER_PROVIDER_FAILED`, culpando al proveedor.
   *
   * Que los desconectados no estorben ya era la regla acá: el cupo de números
   * (#600), la lista de canales (#772) y el chequeo de duplicado de más abajo
   * los excluyen a propósito. Esto aplica el mismo principio al receptor.
   */
  if (primaria.state === 'disconnected' && primaria.id !== cuenta.id) {
    await client.query(
      `UPDATE channel_senders SET webhook_account_id = $3 WHERE sender_id = $1 AND tenant_id = $2`,
      [input.senderId, input.tenantId, cuenta.id],
    );
    await writeAudit(client, {
      tenantId: input.tenantId, actor: input.actor ?? 'system', actorKind: input.actorKind ?? 'system',
      requestId: input.requestId, action: 'channel.sender.rebound', resource: 'channel_account',
      resourceId: cuenta.id, result: 'ok',
      metadata: { senderId: input.senderId, kind: cuenta.kind, receptorAnterior: primaria.id },
    });
    return { webhookAccountId: cuenta.id, primeraConexion: true };
  }
  if (primaria.config.senderId !== input.senderId) throw new Error('El receptor de este emisor cambió. Su conexión debe ser revisada antes de añadir otro canal.');
  if (cuenta.credentialRef !== primaria.credentialRef || cuenta.webhookSecretRef !== primaria.webhookSecretRef) {
    throw new Error('Los canales del mismo emisor deben usar las referencias de su conexión original.');
  }
  const duplicado = await client.query(
    `SELECT id FROM channel_accounts WHERE tenant_id = $1 AND config->>'senderId' = $2
     AND kind = $3 AND state <> 'disconnected' AND id <> $4 LIMIT 1`,
    [input.tenantId, input.senderId, cuenta.kind, cuenta.id],
  );
  if (duplicado.rowCount) throw new Error('Este canal del emisor ya está conectado a tu negocio.');
  await writeAudit(client, {
    tenantId: input.tenantId, actor: input.actor ?? 'system', actorKind: input.actorKind ?? 'system', requestId: input.requestId,
    action: 'channel.sender.bound', resource: 'channel_account', resourceId: cuenta.id, result: 'ok',
    metadata: { senderId: input.senderId, kind: cuenta.kind, webhookAccountId },
  });
  return { webhookAccountId, primeraConexion: webhookAccountId === cuenta.id };
}

export async function emisorAcreditado(client: PoolClient, tenantId: string, senderId: string, bloquear = false) {
  const r = await client.query<{ webhook_account_id: string | null }>(
    bloquear
      ? 'SELECT webhook_account_id FROM channel_senders WHERE tenant_id = $1 AND sender_id = $2 FOR UPDATE'
      : 'SELECT webhook_account_id FROM channel_senders WHERE tenant_id = $1 AND sender_id = $2',
    [tenantId, senderId],
  );
  if (!r.rows[0]?.webhook_account_id) return null;
  const cuenta = await getChannelAccount(client, tenantId, r.rows[0].webhook_account_id);
  return cuenta.config.senderId === senderId ? cuenta : null;
}

export async function emisoresAcreditados(client: PoolClient, tenantId: string) {
  const r = await client.query<{ sender_id: string; webhook_account_id: string }>(
    `SELECT s.sender_id, s.webhook_account_id FROM channel_senders s JOIN channel_accounts c ON c.id=s.webhook_account_id AND c.tenant_id=s.tenant_id
      WHERE s.tenant_id=$1 AND c.config->>'senderId'=s.sender_id ORDER BY s.sender_id`,
    [tenantId],
  );
  return Promise.all(r.rows.map(async (row) => ({
    senderId: row.sender_id,
    cuenta: await getChannelAccount(client, tenantId, row.webhook_account_id),
  })));
}

export async function tenantDelEmisorDeCanal(client: Pick<PoolClient, 'query'>, senderId: string): Promise<string | null> {
  const r = await client.query('SELECT tenant_de_emisor_de_canal($1) AS tenant', [senderId]);
  return (r.rows[0]?.tenant as string | null) ?? null;
}

/** Se usa DESPUÉS de verificar la firma del receptor primario, en su tenant. */
export async function cuentaDelEmisor(
  client: PoolClient,
  input: { tenantId: string; webhookAccountId: string; senderId: string; kind: ChannelKind },
) {
  const r = await client.query<{ id: string }>(
    `SELECT c.id FROM channel_senders s JOIN channel_accounts c
       ON c.tenant_id = s.tenant_id AND c.config->>'senderId' = s.sender_id
     WHERE s.tenant_id = $1 AND s.webhook_account_id = $2 AND s.sender_id = $3
       AND c.kind = $4 AND c.state IN ('active', 'degraded')`,
    [input.tenantId, input.webhookAccountId, input.senderId, input.kind],
  );
  // Nunca adivinar entre dos cuentas (incluidas inconsistencias anteriores).
  return r.rows.length === 1 ? findAccountById(client, r.rows[0].id) : null;
}
