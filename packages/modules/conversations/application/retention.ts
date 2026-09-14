import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '@iaxti/module-audit';
import { presignUrl, publishEvent, type Consumer, type EventEnvelope, type StorageConfig } from '@iaxti/core';

// Retención por plan (#77, SPEC §39): el borrado es FÍSICO y por eso
// ceremonioso — lotes chicos, llaves R2 leídas ANTES del DELETE y
// borradas DESPUÉS del commit, y una entrada de audit por corrida.

const LOTE = 1000;

export interface RetentionCutoff {
  /** null = retención ilimitada: no se borra nada. */
  cutoff: Date | null;
  months: number | null;
  /** Bajada de plan reciente: la primera purga espera hasta esta fecha. */
  deferredUntil: Date | null;
}

/**
 * El corte del tenant: override de settings (validado ≤ plan al
 * guardarse) o el del plan. La bajada de plan deja settings.retencion.
 * firstPurgeAfter — la primera purga espera 30 días (§39).
 */
export async function retentionCutoff(
  client: PoolClient,
  tenantId: string,
  now: Date = new Date(),
): Promise<RetentionCutoff> {
  const r = await client.query(
    `SELECT pl.retention_months,
            t.settings->'retencion'->>'monthsOverride' AS override,
            t.settings->'retencion'->>'firstPurgeAfter' AS first_purge_after
       FROM tenants t LEFT JOIN plan_limits pl ON pl.plan = t.plan
      WHERE t.id = $1`,
    [tenantId],
  );
  if (r.rowCount === 0) return { cutoff: null, months: null, deferredUntil: null };
  const fila = r.rows[0];
  const delPlan = fila.retention_months === null ? null : Number(fila.retention_months);
  const override = Number(fila.override);
  // El override solo puede ACORTAR (≤ plan); uno inválido se ignora.
  const months =
    Number.isFinite(override) && override > 0 && (delPlan === null || override <= delPlan)
      ? override
      : delPlan;
  if (months === null) return { cutoff: null, months: null, deferredUntil: null };
  const deferred = fila.first_purge_after ? new Date(fila.first_purge_after) : null;
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - months);
  return {
    cutoff,
    months,
    deferredUntil: deferred && deferred > now ? deferred : null,
  };
}

/**
 * Al BAJAR la retención (cambio de plan u override): si el corte nuevo
 * capturaría conversaciones, la primera purga se difiere 30 días y se
 * avisa con la CANTIDAD exacta (§39). Subir no recupera nada.
 */
export async function scheduleRetentionNotice(
  client: PoolClient,
  tenantId: string,
  now: Date = new Date(),
): Promise<{ affected: number; firstPurgeAt: Date } | null> {
  const { cutoff } = await retentionCutoff(client, tenantId, now);
  if (!cutoff) return null;
  const r = await client.query(
    `SELECT count(*)::int AS n FROM conversations
      WHERE tenant_id = $1 AND state NOT IN ('new','open','snoozed')
        AND last_message_at < $2`,
    [tenantId, cutoff],
  );
  const affected = r.rows[0].n;
  if (affected === 0) return null;
  const firstPurgeAt = new Date(now.getTime() + 30 * 86_400_000);
  await client.query(
    `UPDATE tenants SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{retencion}',
       COALESCE(settings->'retencion', '{}'::jsonb) || jsonb_build_object('firstPurgeAfter', $2::text))
      WHERE id = $1`,
    [tenantId, firstPurgeAt.toISOString()],
  );
  return { affected, firstPurgeAt };
}

/** El override se VALIDA al guardar: solo retener MENOS o igual (§39). */
export async function setRetentionOverride(
  client: PoolClient,
  input: { tenantId: string; months: number | null },
): Promise<void> {
  if (input.months !== null) {
    if (!(Number(input.months) >= 1)) throw new Error('La retención mínima es de 1 mes.');
    const r = await client.query(
      `SELECT pl.retention_months FROM tenants t
         LEFT JOIN plan_limits pl ON pl.plan = t.plan WHERE t.id = $1`,
      [input.tenantId],
    );
    const delPlan = r.rows[0]?.retention_months;
    if (delPlan !== null && delPlan !== undefined && Number(input.months) > Number(delPlan)) {
      throw new Error(`Tu plan retiene hasta ${delPlan} meses: el ajuste no puede superarlo.`);
    }
  }
  await client.query(
    `UPDATE tenants SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{retencion}',
       COALESCE(settings->'retencion', '{}'::jsonb) || jsonb_build_object('monthsOverride', $2::int))
      WHERE id = $1`,
    [input.tenantId, input.months],
  );
}

/** Al cambiar de plan: si la retención nueva capturaría conversaciones,
 *  la purga se difiere 30 días y sale el aviso con la cantidad EXACTA. */
export function retentionConsumers(): Consumer[] {
  const onPlanChanged = async (event: EventEnvelope, client: PoolClient) => {
    const aviso = await scheduleRetentionNotice(client, event.tenantId);
    if (!aviso) return;
    await publishEvent(client, {
      name: 'conversations.retention.scheduled',
      tenantId: event.tenantId,
      payload: { count: aviso.affected, firstPurgeAt: aviso.firstPurgeAt },
      actor: 'system',
    });
  };
  return [
    {
      name: 'conversations.retention_plan_changed',
      moduleId: 'conversations',
      event: 'tenant.plan_changed',
      handler: onPlanChanged,
    },
  ];
}

export interface PurgeResult {
  purged: number;
  cutoff: string;
  oldest: string | null;
  r2Keys: string[];
}

/**
 * Purga UN tenant en lotes de 1000 por transacción. Jamás borra
 * new/open/snoozed. Devuelve las llaves R2 (leídas ANTES del DELETE):
 * el caller las borra TRAS el commit, con reintento idempotente.
 */
export async function purgeTenantRetention(
  pool: Pool,
  tenantId: string,
  now: Date = new Date(),
): Promise<PurgeResult | null> {
  const client = await pool.connect();
  let corte: RetentionCutoff;
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
    corte = await retentionCutoff(client, tenantId, now);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    client.release();
    throw e;
  }
  client.release();
  if (!corte.cutoff || corte.deferredUntil) return null;

  const r2Keys: string[] = [];
  let purged = 0;
  let oldest: string | null = null;

  for (;;) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
      const lote = await c.query(
        `SELECT id, last_message_at FROM conversations
          WHERE tenant_id = $1 AND state NOT IN ('new','open','snoozed')
            AND last_message_at < $2
          ORDER BY last_message_at LIMIT $3 FOR UPDATE SKIP LOCKED`,
        [tenantId, corte.cutoff, LOTE],
      );
      if (lote.rowCount === 0) {
        await c.query('COMMIT');
        c.release();
        break;
      }
      const ids = lote.rows.map((f) => f.id);
      oldest ??= new Date(lote.rows[0].last_message_at).toISOString();

      // Las llaves R2 ANTES del DELETE (§39): adjuntos de los mensajes.
      const adjuntos = await c.query(
        `SELECT jsonb_array_elements(attachments)->>'key' AS key FROM messages
          WHERE tenant_id = $1 AND conversation_id = ANY($2::uuid[])
            AND jsonb_array_length(attachments) > 0`,
        [tenantId, ids],
      );
      for (const fila of adjuntos.rows) if (fila.key) r2Keys.push(fila.key);

      // El orden respeta los FK; las tablas sin FK se limpian igual
      // (nada de huérfanas). Contact, Deal y Appointment NO se tocan.
      await c.query(`UPDATE webchat_sessions SET conversation_id = NULL WHERE tenant_id = $1 AND conversation_id = ANY($2::uuid[])`, [tenantId, ids]);
      for (const tabla of ['internal_notes', 'assignments', 'suggestions', 'agent_conversation_modes', 'sequence_enrollments', 'response_samples', 'messages']) {
        await c.query(`DELETE FROM ${tabla} WHERE tenant_id = $1 AND conversation_id = ANY($2::uuid[])`, [tenantId, ids]);
      }
      await c.query(`DELETE FROM conversations WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [tenantId, ids]);
      await c.query('COMMIT');
      purged += lote.rowCount ?? 0;
    } catch (e) {
      await c.query('ROLLBACK');
      c.release();
      throw e;
    }
    c.release();
  }

  if (purged === 0) return null;

  // UNA entrada de audit por tenant y corrida (§39): corte, cantidad, rango.
  const cAudit = await pool.connect();
  try {
    await cAudit.query('BEGIN');
    await cAudit.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
    await writeAudit(cAudit, {
      tenantId,
      actor: 'system',
      actorKind: 'system',
      action: 'conversations.retention.purged',
      resource: 'tenant',
      resourceId: tenantId,
      result: 'ok',
      metadata: {
        cutoff: corte.cutoff.toISOString(),
        months: corte.months,
        purged,
        oldest,
        r2Keys: r2Keys.length,
      },
    });
    await publishEvent(cAudit, {
      name: 'conversations.retention.purged',
      tenantId,
      payload: { cutoff: corte.cutoff.toISOString(), purged, months: corte.months },
      actor: 'system',
    });
    // La purga diferida ya corrió: la marca de 30 días se limpia.
    await cAudit.query(
      `UPDATE tenants SET settings = settings #- '{retencion,firstPurgeAfter}'
        WHERE id = $1 AND settings->'retencion' ? 'firstPurgeAfter'`,
      [tenantId],
    );
    await cAudit.query('COMMIT');
  } finally {
    cAudit.release();
  }

  return { purged, cutoff: corte.cutoff.toISOString(), oldest, r2Keys };
}

/** Borra los objetos R2 TRAS el commit — idempotente: un 404 es éxito. */
export async function deleteR2Keys(
  storage: StorageConfig,
  keys: string[],
  fetcher: typeof fetch = fetch,
): Promise<{ deleted: number; failed: number }> {
  const res = { deleted: 0, failed: 0 };
  for (const key of keys) {
    try {
      const r = await fetcher(presignUrl(storage, 'DELETE', key), { method: 'DELETE' });
      if (r.ok || r.status === 404) res.deleted += 1;
      else res.failed += 1;
    } catch {
      res.failed += 1;
    }
  }
  return res;
}

/** Tenants ACTIVOS con retención finita (el padre del job, §39). */
export async function tenantsWithRetention(pool: Pick<Pool, 'query'>): Promise<string[]> {
  const r = await pool.query(
    `SELECT t.id FROM tenants t
       LEFT JOIN plan_limits pl ON pl.plan = t.plan
      WHERE t.state = 'active'
        AND (pl.retention_months IS NOT NULL
             OR (t.settings->'retencion'->>'monthsOverride') IS NOT NULL)`,
  );
  return r.rows.map((x) => x.id);
}
