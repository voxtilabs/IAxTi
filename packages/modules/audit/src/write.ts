import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';

export type ActorKind = 'user' | 'agent' | 'system' | 'superadmin' | 'apikey';

export interface AuditEntry {
  tenantId: string;
  actor: string;
  actorKind: ActorKind;
  action: string;
  resource: string;
  resourceId?: string;
  ip?: string;
  userAgent?: string;
  result: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
}

function chainHash(prevHash: string | null, entry: AuditEntry, occurredAt: string): string {
  const canonical = JSON.stringify({
    prev: prevHash,
    t: entry.tenantId,
    a: entry.actor,
    k: entry.actorKind,
    ac: entry.action,
    r: entry.resource,
    ri: entry.resourceId ?? null,
    at: occurredAt,
    res: entry.result,
    rq: entry.requestId ?? null,
    m: entry.metadata ?? {},
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Escribe la entrada DENTRO de la transacción del caso de uso (mismo
 * PoolClient de withTenant): si la mutación falla, la entrada no existe
 * (SPEC §13). El encadenamiento por tenant se serializa con un advisory
 * lock transaccional para que el hash previo no tenga carreras.
 */
export async function writeAudit(client: PoolClient, entry: AuditEntry): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`audit:${entry.tenantId}`]);

  // jsonb reordena claves (también anidadas). Hashear el objeto original
  // hacía que verifyChain denunciara cambios tras una escritura legítima.
  // Normalizamos con el mismo motor/tipo que almacena, en la consulta que
  // ya buscaba el hash anterior: sin cambiar el formato ni sumar un viaje.
  const prev = await client.query<{ hash: string | null; metadata: Record<string, unknown> }>(
    `SELECT (SELECT hash FROM audit_log WHERE tenant_id = $1 ORDER BY id DESC LIMIT 1) AS hash,
            $2::jsonb AS metadata`,
    [entry.tenantId, JSON.stringify(entry.metadata ?? {})],
  );
  const prevHash = prev.rows[0].hash;
  const metadata = prev.rows[0].metadata;
  const occurredAt = new Date().toISOString();
  const hash = chainHash(prevHash, { ...entry, metadata }, occurredAt);

  await client.query(
    `INSERT INTO audit_log
       (tenant_id, actor, actor_kind, action, resource, resource_id,
        occurred_at, ip, user_agent, result, request_id, metadata, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      entry.tenantId,
      entry.actor,
      entry.actorKind,
      entry.action,
      entry.resource,
      entry.resourceId ?? null,
      occurredAt,
      entry.ip ?? null,
      entry.userAgent ?? null,
      entry.result,
      entry.requestId ?? null,
      JSON.stringify(metadata),
      prevHash,
      hash,
    ],
  );
}

export interface ChainCheck {
  valid: boolean;
  entries: number;
  brokenAtId?: number;
}

/** Reverifica la cadena completa del tenant recalculando cada hash. */
export async function verifyChain(client: PoolClient, tenantId: string): Promise<ChainCheck> {
  const rows = await client.query(
    `SELECT id, actor, actor_kind, action, resource, resource_id,
            occurred_at, result, request_id, metadata, prev_hash, hash
       FROM audit_log WHERE tenant_id = $1 ORDER BY id ASC`,
    [tenantId],
  );

  let prevHash: string | null = null;
  for (const row of rows.rows) {
    const expected = chainHash(
      prevHash,
      {
        tenantId,
        actor: row.actor,
        actorKind: row.actor_kind,
        action: row.action,
        resource: row.resource,
        resourceId: row.resource_id ?? undefined,
        result: row.result,
        requestId: row.request_id ?? undefined,
        metadata: row.metadata,
      },
      new Date(row.occurred_at).toISOString(),
    );
    if (row.prev_hash !== prevHash || row.hash !== expected) {
      return { valid: false, entries: rows.rowCount ?? 0, brokenAtId: Number(row.id) };
    }
    prevHash = row.hash;
  }
  return { valid: true, entries: rows.rowCount ?? 0 };
}
