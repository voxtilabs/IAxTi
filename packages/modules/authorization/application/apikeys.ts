import { createHash, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '@iaxti/module-audit';

// API keys por tenant (#24, SPEC §7/§8): el ADMIN se integra solo, sin
// pasar por soporte. El token se muestra UNA vez; en la base vive SOLO
// el hash. Una key jamás puede más que los permisos de su tenant.

export interface ApiKey {
  id: string;
  name: string;
  scopes: string[];
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

function rowToApiKey(row: Record<string, unknown>): ApiKey {
  return {
    id: row.id as string,
    name: row.name as string,
    scopes: (row.scopes as string[]) ?? [],
    expiresAt: (row.expires_at as Date) ?? null,
    lastUsedAt: (row.last_used_at as Date) ?? null,
    revokedAt: (row.revoked_at as Date) ?? null,
    createdAt: row.created_at as Date,
  };
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Crea la key: scopes = SUBCONJUNTO del catálogo de permisos (lo que no
 * está en el catálogo ni existe ni se puede pedir). Devuelve el token en
 * claro UNA sola vez.
 */
export async function createApiKey(
  client: PoolClient,
  input: {
    tenantId: string;
    name: string;
    scopes: string[];
    catalog: ReadonlySet<string>;
    expiresAt?: Date | null;
    actor: string;
    requestId?: string;
  },
): Promise<{ token: string; apiKey: ApiKey }> {
  if (!input.name?.trim()) throw new Error('La key necesita un nombre (para reconocerla después).');
  if (!Array.isArray(input.scopes) || input.scopes.length === 0) {
    throw new Error('Elige al menos un permiso (scope) para la key.');
  }
  const fuera = input.scopes.filter((s) => !input.catalog.has(s));
  if (fuera.length > 0) {
    throw new Error(`Estos permisos no existen en el catálogo: ${fuera.join(', ')}.`);
  }
  if (input.scopes.some((s) => s.startsWith('platform.'))) {
    throw new Error('Los permisos de plataforma no se delegan a una API key.');
  }
  const token = `iaxti_${randomBytes(32).toString('base64url')}`;
  const r = await client.query(
    `INSERT INTO api_keys (tenant_id, name, key_hash, scopes, expires_at)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [
      input.tenantId,
      input.name.trim(),
      hashToken(token),
      JSON.stringify(input.scopes),
      input.expiresAt ?? null,
    ],
  );
  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: input.actor,
    actorKind: 'user',
    action: 'authorization.apikey.create',
    resource: 'api_key',
    resourceId: r.rows[0].id,
    result: 'ok',
    metadata: { name: input.name.trim(), scopes: input.scopes },
    requestId: input.requestId,
  });
  return { token, apiKey: rowToApiKey(r.rows[0]) };
}

export async function listApiKeys(client: PoolClient, tenantId: string): Promise<ApiKey[]> {
  const r = await client.query(
    'SELECT * FROM api_keys WHERE tenant_id = $1 ORDER BY created_at DESC',
    [tenantId],
  );
  return r.rows.map(rowToApiKey);
}

export async function revokeApiKey(
  client: PoolClient,
  input: { tenantId: string; apiKeyId: string; actor: string; requestId?: string },
): Promise<void> {
  const r = await client.query(
    `UPDATE api_keys SET revoked_at = now() WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL`,
    [input.tenantId, input.apiKeyId],
  );
  if (r.rowCount === 0) throw new Error('Esa key no existe o ya estaba revocada.');
  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: input.actor,
    actorKind: 'user',
    action: 'authorization.apikey.revoke',
    resource: 'api_key',
    resourceId: input.apiKeyId,
    result: 'ok',
    requestId: input.requestId,
  });
}

export interface ResolvedApiKey {
  id: string;
  tenantId: string;
  scopes: string[];
}

/**
 * Resuelve el token para el guard: hash → key viva (ni revocada ni
 * vencida). Registra el último uso (a lo más una vez por minuto). El
 * lookup es por hash único — la key trae su tenant: jamás cross-tenant.
 */
export async function resolveApiKey(
  pool: Pick<Pool, 'query'>,
  token: string,
): Promise<ResolvedApiKey | null> {
  if (!token.startsWith('iaxti_')) return null;
  const r = await pool.query(
    `SELECT id, tenant_id, scopes FROM api_keys
      WHERE key_hash = $1 AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())`,
    [hashToken(token)],
  );
  if (r.rowCount === 0) return null;
  await pool.query(
    `UPDATE api_keys SET last_used_at = now()
      WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
    [r.rows[0].id],
  );
  return { id: r.rows[0].id, tenantId: r.rows[0].tenant_id, scopes: r.rows[0].scopes ?? [] };
}
