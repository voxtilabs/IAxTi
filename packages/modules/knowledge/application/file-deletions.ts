import type { Pool, PoolClient } from 'pg';
import { withTenant } from '@iaxti/db';
import type { ConsultaObjetos } from '@iaxti/core';
import { writeAudit } from '@iaxti/module-audit';

/** Borrar y reconciliar bloquean el archivo ANTES de tocar filas.
 * Transaccional: funciona también detrás de un pooler en modo transacción. */
export async function bloquearArchivo(
  client: PoolClient, tenantId: string, key: string, intentar = false,
): Promise<boolean> {
  if (!key.startsWith(`${tenantId}/`)) throw new Error('Esa llave no es de este negocio.');
  const lock = `${tenantId}:${key}`;
  if (intentar) {
    const r = await client.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1, 751)) AS libre', [lock]);
    return r.rows[0].libre as boolean;
  }
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 751))', [lock]);
  return true;
}

/** Marca y audita en la misma transacción; repetir no duplica el libro. */
export async function marcarSinArchivo(
  client: PoolClient, input: { tenantId: string; sourceId: string },
): Promise<boolean> {
  const marked = await client.query(
    `UPDATE sources SET status = 'delete_failed',
       error = 'Se eliminó el archivo guardado y la eliminación de la fuente no llegó a completarse. Vuelve a subir el documento o termina de borrar la fuente.',
       updated_at = now()
     WHERE tenant_id = $1 AND id = $2 AND status <> 'delete_failed' RETURNING id`,
    [input.tenantId, input.sourceId],
  );
  if (!marked.rowCount) return false;
  await writeAudit(client, {
    tenantId: input.tenantId, actor: 'system', actorKind: 'system',
    action: 'knowledge.source.sin_archivo', resource: 'source', resourceId: input.sourceId,
    result: 'ok', metadata: { motivo: 'el archivo se borró y la transacción no confirmó' },
  });
  return true;
}

export interface ReconciliacionDeBorrados {
  revisadas: number;
  marcadas: number;
  limpiadas: number;
  ocupadas: number;
  desconocidas: number;
}

/** Observa la realidad con HEAD. Este puerto NO ofrece borrar objetos. */
export async function reconciliarBorradosPendientes(
  pool: Pool,
  consulta: ConsultaObjetos,
  options: { now?: Date; minAgeMs?: number; limit?: number } = {},
): Promise<ReconciliacionDeBorrados> {
  const now = options.now ?? new Date();
  const age = options.minAgeMs ?? 300_000;
  const limit = options.limit ?? 100;
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(age) || age < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error('El barrido necesita una fecha, antigüedad y tamaño de lote válidos.');
  }
  const cutoff = new Date(now.getTime() - age);
  const tenants = await pool.query('SELECT tenant_id FROM tenants_con_borrados_de_conocimiento($1)', [cutoff]);
  const total: ReconciliacionDeBorrados = { revisadas: 0, marcadas: 0, limpiadas: 0, ocupadas: 0, desconocidas: 0 };
  for (const { tenant_id: tenantId } of tenants.rows) {
    const candidates = await withTenant(pool, tenantId, async (c) => (await c.query(
      `SELECT source_id, r2_key FROM pending_file_deletions
        WHERE tenant_id = $1 AND created_at <= $2 ORDER BY created_at, source_id LIMIT $3`,
      [tenantId, cutoff, limit],
    )).rows);
    for (const candidate of candidates) {
      const result = await withTenant(pool, tenantId, async (c) => {
        // Antigüedad no prueba que el DELETE haya terminado. Un R2 lento puede
        // durar más que N: si conserva el lock, no se toca NI la intención.
        if (!await bloquearArchivo(c, tenantId, candidate.r2_key, true)) return 'ocupada';
        const pending = await c.query(
          `SELECT r2_key FROM pending_file_deletions
            WHERE tenant_id = $1 AND source_id = $2 AND created_at <= $3
            FOR UPDATE SKIP LOCKED`, [tenantId, candidate.source_id, cutoff],
        );
        if (!pending.rowCount) return 'omitida';
        if (pending.rows[0].r2_key !== candidate.r2_key) return 'omitida';
        const source = await c.query(
          `SELECT r2_key FROM sources WHERE tenant_id = $1 AND id = $2 FOR UPDATE SKIP LOCKED`,
          [tenantId, candidate.source_id],
        );
        if (!source.rowCount) {
          // SKIP LOCKED también puede ocultar una fuente que está procesándose.
          // Distinguirla de ausente evita limpiar su intención por error.
          const exists = await c.query('SELECT 1 FROM sources WHERE tenant_id = $1 AND id = $2', [tenantId, candidate.source_id]);
          if (exists.rowCount) return 'ocupada';
        }
        let marked = false;
        if (source.rowCount && source.rows[0].r2_key === candidate.r2_key) {
          const state = await consulta.estado(candidate.r2_key).catch(() => 'desconocido' as const);
          if (state === 'desconocido') return 'desconocida';
          if (state === 'ausente') {
            marked = await marcarSinArchivo(c, { tenantId, sourceId: candidate.source_id });
          }
          // HEAD presente no cambia status: no revive una fuente expirada o fallida.
        }
        await c.query('DELETE FROM pending_file_deletions WHERE tenant_id = $1 AND source_id = $2', [tenantId, candidate.source_id]);
        return marked ? 'marcada' : 'limpiada';
      });
      if (result === 'omitida') continue;
      total.revisadas += 1;
      if (result === 'ocupada') total.ocupadas += 1;
      if (result === 'desconocida') total.desconocidas += 1;
      if (result === 'marcada') total.marcadas += 1;
      if (result === 'limpiada') total.limpiadas += 1;
    }
  }
  return total;
}
