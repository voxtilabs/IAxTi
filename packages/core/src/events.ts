import type { PoolClient } from 'pg';

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
}

/**
 * Publica en el outbox DENTRO de la transacción del caso de uso: si la
 * mutación se revierte, el evento no existe. El publicador nunca conoce al
 * consumidor (SPEC §26 regla 6).
 */
export async function publishEvent(client: PoolClient, input: PublishInput): Promise<void> {
  await client.query(
    `INSERT INTO outbox (name, tenant_id, payload, actor, request_id, version)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.name,
      input.tenantId,
      JSON.stringify(input.payload ?? {}),
      input.actor ?? null,
      input.requestId ?? null,
      input.version ?? 1,
    ],
  );
}
