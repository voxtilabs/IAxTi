import type { PoolClient } from 'pg';
import { contextoDeTraza } from '@iaxti/telemetry';
import { MAX_ATTEMPTS } from './outbox-policy';

/** Sobre de todo evento (SPEC §24). */
export interface EventEnvelope {
  id: number;
  name: string;
  tenantId: string;
  payload: Record<string, unknown>;
  actor: string | null;
  requestId: string | null;
  version: number;
  occurredAt: Date;
}

export interface PublishInput {
  name: string;
  tenantId: string;
  payload?: Record<string, unknown>;
  actor?: string;
  requestId?: string;
  version?: number;
  /** Solo traceparent W3C: nunca baggage ni datos de la solicitud. */
  propagateTrace?: boolean;
}

/**
 * Publica en el outbox DENTRO de la transacción del caso de uso: si la
 * mutación se revierte, el evento no existe. El publicador nunca conoce al
 * consumidor (SPEC §26 regla 6).
 */
export async function publishEvent(client: PoolClient, input: PublishInput): Promise<void> {
  const traceparent = input.propagateTrace ? contextoDeTraza().traceparent : undefined;
  const payload = { ...(input.payload ?? {}), ...(traceparent ? { __traza: { traceparent } } : {}) };
  await client.query(
    `INSERT INTO outbox (name, tenant_id, payload, actor, request_id, version)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.name,
      input.tenantId,
      JSON.stringify(payload),
      input.actor ?? null,
      input.requestId ?? null,
      input.version ?? 1,
    ],
  );
}

/** Recupera un pedido agotado; el caller autoriza el recurso y audita en esta transacción. */
export async function retryExhaustedEvent(
  client: PoolClient,
  input: { tenantId: string; name: string; payload: Record<string, unknown> },
): Promise<number | null> {
  const r = await client.query(
    `UPDATE outbox SET attempts = 0, last_error = NULL
      WHERE id = (
        SELECT id FROM outbox
         WHERE tenant_id = $1 AND name = $2 AND payload @> $3::jsonb
           AND processed_at IS NULL AND attempts >= $4
         ORDER BY id DESC LIMIT 1 FOR UPDATE
      ) RETURNING id`,
    [input.tenantId, input.name, JSON.stringify(input.payload), MAX_ATTEMPTS],
  );
  return r.rowCount ? Number(r.rows[0].id) : null;
}
