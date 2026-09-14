import type { Pool, PoolClient } from 'pg';
import type { Consumer, EventEnvelope } from '@iaxti/core';
import { withTenant } from '@iaxti/db';
import { TOTAL_OWNER, type Metric } from '../domain/metrics';

// La agregación (#66): POR EVENTO, en la misma transacción del dispatcher
// — el dashboard después solo SUMA filas de daily_metrics.

export async function bump(
  client: PoolClient,
  input: {
    tenantId: string;
    metric: Metric;
    value?: number;
    ownerId?: string | null;
    day?: Date;
  },
): Promise<void> {
  const day = (input.day ?? new Date()).toISOString().slice(0, 10);
  const owners = [TOTAL_OWNER, ...(input.ownerId ? [input.ownerId] : [])];
  for (const owner of owners) {
    await client.query(
      `INSERT INTO daily_metrics (tenant_id, day, metric, owner_id, value)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, day, metric, owner_id)
       DO UPDATE SET value = daily_metrics.value + $5`,
      [input.tenantId, day, input.metric, owner, input.value ?? 1],
    );
  }
}

async function handleEvent(event: EventEnvelope, client: PoolClient): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const tenantId = event.tenantId;
  switch (event.name) {
    case 'conversation.created':
      return bump(client, { tenantId, metric: 'conversaciones_nuevas' });
    case 'conversation.state_changed':
      if (p.to === 'resolved') {
        // El dueño que resolvió, si el evento vino de un humano.
        const owner = typeof event.actor === 'string' && /^[0-9a-f-]{36}$/.test(event.actor) ? event.actor : null;
        return bump(client, { tenantId, metric: 'resueltas', ownerId: owner });
      }
      return;
    case 'deal.created':
      return bump(client, { tenantId, metric: 'oportunidades_creadas' });
    case 'deal.won': {
      await bump(client, { tenantId, metric: 'ganadas' });
      const valor = Number(p.valueClp);
      if (Number.isFinite(valor) && valor > 0) {
        await bump(client, { tenantId, metric: 'valor_ganado_clp', value: valor });
      }
      return;
    }
    case 'deal.lost':
      return bump(client, { tenantId, metric: 'perdidas' });
    case 'agent.executed': {
      await bump(client, { tenantId, metric: 'ia_ejecuciones' });
      const costo = Number(p.costUsd);
      if (Number.isFinite(costo) && costo > 0) {
        await bump(client, { tenantId, metric: 'ia_costo_usd', value: costo });
      }
      return;
    }
    case 'message.sent': {
      await bump(client, { tenantId, metric: 'mensajes_enviados' });
      // El costo de Meta viaja en meta.costo del mensaje (#43), si existe.
      const fila = await client.query(
        `SELECT meta->>'costo' AS costo FROM messages WHERE tenant_id = $1 AND id = $2`,
        [tenantId, p.messageId],
      );
      const costo = Number(fila.rows[0]?.costo);
      if (Number.isFinite(costo) && costo > 0) {
        await bump(client, { tenantId, metric: 'costo_meta_usd', value: costo });
      }
      return;
    }
    default:
      return;
  }
}

const EVENTOS = [
  'conversation.created',
  'conversation.state_changed',
  'deal.created',
  'deal.won',
  'deal.lost',
  'agent.executed',
  'message.sent',
] as const;

/** Los consumidores para el OutboxDispatcher. */
export function analyticsConsumers(): Consumer[] {
  return EVENTOS.map((event) => ({
    name: `analytics.${event}`,
    moduleId: 'analytics',
    event,
    handler: handleEvent,
  }));
}

/**
 * El barrido de primera respuesta (horario): una MUESTRA por conversación
 * respondida — mediana y p90 reales sin barrer messages en vivo.
 */
export async function sweepResponseSamples(pool: Pool): Promise<number> {
  const tenants = await pool.query(
    `SELECT DISTINCT tenant_id FROM conversations
      WHERE first_response_at > now() - interval '26 hours'`,
  );
  let total = 0;
  for (const { tenant_id: tenantId } of tenants.rows) {
    total += await withTenant(pool, tenantId, async (client) => {
      const r = await client.query(
        `INSERT INTO response_samples (tenant_id, conversation_id, owner_id, day, seconds)
         SELECT c.tenant_id, c.id, c.owner_id, c.first_response_at::date,
                GREATEST(1, EXTRACT(EPOCH FROM (c.first_response_at - c.created_at)))::int
           FROM conversations c
          WHERE c.tenant_id = $1 AND c.first_response_at > now() - interval '26 hours'
          ON CONFLICT (tenant_id, conversation_id) DO NOTHING`,
        [tenantId],
      );
      return r.rowCount ?? 0;
    });
  }
  return total;
}
