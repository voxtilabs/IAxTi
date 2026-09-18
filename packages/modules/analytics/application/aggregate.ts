import type { Pool, PoolClient } from 'pg';
import { TZ_POR_DEFECTO, diaEn, type Consumer, type EventEnvelope } from '@iaxti/core';
import { zonaDelTenant } from '@iaxti/module-organizations';
import { idsDeTenants, withTenant } from '@iaxti/db';
import { montoDelCosto } from '../domain/metrics';
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
    /** Zona del negocio; define qué día es "hoy" para sus números. */
    timeZone?: string;
  },
): Promise<void> {
  // El día del NEGOCIO, no el de UTC: a las 22:00 en Chile todavía es hoy.
  const day = diaEn(input.timeZone ?? process.env.IAXTI_TZ ?? TZ_POR_DEFECTO, input.day ?? new Date());
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
  // El día se cierra en la zona del NEGOCIO, no en la del servidor ni en la
  // del producto: para un tenant fuera de Chile, "hoy" es otro día.
  const timeZone = await zonaDelTenant(client, tenantId);
  switch (event.name) {
    case 'conversation.created':
      return bump(client, { tenantId, metric: 'conversaciones_nuevas', timeZone });
    case 'conversation.state_changed':
      if (p.to === 'resolved') {
        // El dueño que resolvió, si el evento vino de un humano.
        const owner = typeof event.actor === 'string' && /^[0-9a-f-]{36}$/.test(event.actor) ? event.actor : null;
        return bump(client, { tenantId, metric: 'resueltas', ownerId: owner, timeZone });
      }
      return;
    case 'deal.created':
      return bump(client, { tenantId, metric: 'oportunidades_creadas', timeZone });
    case 'deal.won': {
      await bump(client, { tenantId, metric: 'ganadas', timeZone });
      const valor = Number(p.valueClp);
      if (Number.isFinite(valor) && valor > 0) {
        await bump(client, { tenantId, metric: 'valor_ganado_clp', value: valor, timeZone });
      }
      return;
    }
    case 'deal.lost':
      return bump(client, { tenantId, metric: 'perdidas', timeZone });
    case 'agent.executed': {
      await bump(client, { tenantId, metric: 'ia_ejecuciones', timeZone });
      const costo = Number(p.costUsd);
      if (Number.isFinite(costo) && costo > 0) {
        await bump(client, { tenantId, metric: 'ia_costo_usd', value: costo, timeZone });
      }
      return;
    }
    case 'message.sent': {
      await bump(client, { tenantId, metric: 'mensajes_enviados', timeZone });
      // El costo de Meta viaja en meta.costo del mensaje (#43), si existe.
      const fila = await client.query(
        // `meta->'costo'` (jsonb), no `->>`: el costo es un OBJETO, y pedirlo
        // como texto daba `Number('{"amount":…}')` = NaN.
        `SELECT meta->'costo' AS costo FROM messages WHERE tenant_id = $1 AND id = $2`,
        [tenantId, p.messageId],
      );
      const costo = montoDelCosto(fila.rows[0]?.costo);
      if (costo !== null) {
        await bump(client, { tenantId, metric: 'costo_meta_usd', value: costo, timeZone });
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
  // De `tenants`, no de `conversations` (#286): esa tabla tiene RLS y una
  // consulta suelta devuelve cero filas con el rol de producción — o sea,
  // el dashboard del dueño se quedaba sin números y nadie veía un error.
  let total = 0;
  for (const tenantId of await idsDeTenants(pool)) {
    total += await withTenant(pool, tenantId, async (client) => {
      const r = await client.query(
        // El día del NEGOCIO, igual que en daily_metrics: `::date` a secas
        // usa la zona de la SESIÓN (UTC en el servidor) y a las 22:00 en
        // Chile eso ya es mañana — la muestra caía fuera del rango del
        // tablero y los percentiles salían vacíos.
        `INSERT INTO response_samples (tenant_id, conversation_id, owner_id, day, seconds)
         SELECT c.tenant_id, c.id, c.owner_id,
                (c.first_response_at AT TIME ZONE COALESCE(t.timezone, $2))::date,
                GREATEST(1, EXTRACT(EPOCH FROM (c.first_response_at - c.created_at)))::int
           FROM conversations c
           JOIN tenants t ON t.id = c.tenant_id
          WHERE c.tenant_id = $1 AND c.first_response_at > now() - interval '26 hours'
          ON CONFLICT (tenant_id, conversation_id) DO NOTHING`,
        [tenantId, TZ_POR_DEFECTO],
      );
      return r.rowCount ?? 0;
    });
  }
  return total;
}
