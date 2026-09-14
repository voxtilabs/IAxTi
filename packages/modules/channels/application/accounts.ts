import type { PoolClient } from 'pg';
import { publishEvent } from '@iaxti/core';
import { assertChannelTransition } from '../domain/port';
import type { ChannelAccountRef, ChannelKind, ChannelState } from '../domain/port';

function rowToAccount(row: Record<string, unknown>): ChannelAccountRef {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    kind: row.kind as ChannelKind,
    name: row.name as string,
    state: row.state as ChannelState,
    credentialRef: (row.credential_ref as string) ?? null,
    config: (row.config as Record<string, unknown>) ?? {},
  };
}

export async function createChannelAccount(
  client: PoolClient,
  input: {
    tenantId: string;
    kind: ChannelKind;
    name: string;
    credentialRef?: string;
    webhookSecretRef?: string;
    config?: Record<string, unknown>;
  },
): Promise<ChannelAccountRef> {
  const r = await client.query(
    `INSERT INTO channel_accounts (tenant_id, kind, name, credential_ref, webhook_secret_ref, config)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      input.tenantId,
      input.kind,
      input.name,
      input.credentialRef ?? null,
      input.webhookSecretRef ?? null,
      JSON.stringify(input.config ?? {}),
    ],
  );
  return rowToAccount(r.rows[0]);
}

export async function getChannelAccount(
  client: PoolClient,
  tenantId: string,
  accountId: string,
): Promise<ChannelAccountRef & { webhookSecretRef: string | null }> {
  const r = await client.query(
    'SELECT * FROM channel_accounts WHERE tenant_id = $1 AND id = $2',
    [tenantId, accountId],
  );
  if (r.rowCount === 0) throw new Error('No encontramos esa cuenta de canal.');
  return {
    ...rowToAccount(r.rows[0]),
    webhookSecretRef: (r.rows[0].webhook_secret_ref as string) ?? null,
  };
}

/** El webhook llega SIN tenant: la cuenta se ubica por su id global. */
export async function findAccountById(
  client: PoolClient,
  accountId: string,
): Promise<(ChannelAccountRef & { webhookSecretRef: string | null }) | null> {
  const r = await client.query('SELECT * FROM channel_accounts WHERE id = $1', [accountId]);
  if (r.rowCount === 0) return null;
  return {
    ...rowToAccount(r.rows[0]),
    webhookSecretRef: (r.rows[0].webhook_secret_ref as string) ?? null,
  };
}

const EVENTO_POR_ESTADO: Partial<Record<ChannelState, string>> = {
  active: 'channel.connected',
  degraded: 'channel.degraded',
  disconnected: 'channel.disconnected',
};

export async function setChannelState(
  client: PoolClient,
  input: { tenantId: string; accountId: string; state: ChannelState; reason?: string; requestId?: string },
): Promise<ChannelAccountRef> {
  const actual = await getChannelAccount(client, input.tenantId, input.accountId);
  if (actual.state === input.state) return actual;
  assertChannelTransition(actual.state, input.state);
  const r = await client.query(
    `UPDATE channel_accounts SET state = $3, updated_at = now()
     WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [input.tenantId, input.accountId, input.state],
  );
  const evento = EVENTO_POR_ESTADO[input.state];
  if (evento) {
    await publishEvent(client, {
      name: evento,
      tenantId: input.tenantId,
      payload: { accountId: input.accountId, kind: actual.kind, reason: input.reason ?? null },
      actor: 'system',
      requestId: input.requestId,
    });
  }
  return rowToAccount(r.rows[0]);
}

export async function listChannelAccounts(
  client: PoolClient,
  tenantId: string,
): Promise<ChannelAccountRef[]> {
  const r = await client.query(
    'SELECT * FROM channel_accounts WHERE tenant_id = $1 ORDER BY created_at',
    [tenantId],
  );
  return r.rows.map(rowToAccount);
}
