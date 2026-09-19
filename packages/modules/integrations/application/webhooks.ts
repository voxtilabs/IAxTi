import type { Pool, PoolClient } from 'pg';
import { publishEvent, type Consumer, type EventEnvelope } from '@iaxti/core';
import { porCadaTenant, withTenant } from '@iaxti/db';
import { writeAudit } from '@iaxti/module-audit';
import { MAX_ATTEMPTS, backoffMinutes, newWebhookSecret, signPayload } from '../domain/signing';

// Webhooks salientes (#76): el consumer del outbox ENCOLA la entrega
// (jamás llama HTTP dentro de la transacción del despachador); el barrido
// entrega con firma, reintentos exponenciales, y apaga con aviso al que
// falla sostenido. Solo eventos del tenant dueño — jamás cross-tenant.

export interface WebhookEndpoint {
  id: string;
  url: string;
  events: string[];
  secret: string;
  active: boolean;
  failingSince: Date | null;
  disabledReason: string | null;
  createdAt: Date;
}

function rowToEndpoint(row: Record<string, unknown>): WebhookEndpoint {
  return {
    id: row.id as string,
    url: row.url as string,
    events: (row.events as string[]) ?? [],
    secret: row.secret as string,
    active: row.active as boolean,
    failingSince: (row.failing_since as Date) ?? null,
    disabledReason: (row.disabled_reason as string) ?? null,
    createdAt: row.created_at as Date,
  };
}

export async function createEndpoint(
  client: PoolClient,
  input: {
    tenantId: string;
    url: string;
    events: string[];
    catalog: ReadonlySet<string>;
    actor: string;
    requestId?: string;
  },
): Promise<WebhookEndpoint> {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new Error('La URL del webhook no se entiende.');
  }
  if (url.protocol !== 'https:' && process.env.IAXTI_ENV === 'production') {
    throw new Error('En producción los webhooks van por https.');
  }
  if (!Array.isArray(input.events) || input.events.length === 0) {
    throw new Error('Elige al menos un evento del catálogo.');
  }
  const fuera = input.events.filter((e) => !input.catalog.has(e));
  if (fuera.length > 0) {
    throw new Error(`Estos eventos no existen en el catálogo: ${fuera.join(', ')}.`);
  }
  const r = await client.query(
    `INSERT INTO webhook_endpoints (tenant_id, url, events, secret)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [input.tenantId, input.url, JSON.stringify(input.events), newWebhookSecret()],
  );
  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: input.actor,
    actorKind: 'user',
    action: 'integrations.webhook.create',
    resource: 'webhook_endpoint',
    resourceId: r.rows[0].id,
    result: 'ok',
    metadata: { url: input.url, events: input.events },
    requestId: input.requestId,
  });
  return rowToEndpoint(r.rows[0]);
}

export async function listEndpoints(client: PoolClient, tenantId: string): Promise<WebhookEndpoint[]> {
  const r = await client.query(
    'SELECT * FROM webhook_endpoints WHERE tenant_id = $1 ORDER BY created_at',
    [tenantId],
  );
  return r.rows.map(rowToEndpoint);
}

/** Rota el secreto de firma; el anterior deja de valer al instante. */
export async function rotateSecret(
  client: PoolClient,
  input: { tenantId: string; endpointId: string; actor: string; requestId?: string },
): Promise<WebhookEndpoint> {
  const r = await client.query(
    `UPDATE webhook_endpoints SET secret = $3, updated_at = now()
      WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [input.tenantId, input.endpointId, newWebhookSecret()],
  );
  if (r.rowCount === 0) throw new Error('No encontramos ese webhook.');
  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: input.actor,
    actorKind: 'user',
    action: 'integrations.webhook.rotate_secret',
    resource: 'webhook_endpoint',
    resourceId: input.endpointId,
    result: 'ok',
    requestId: input.requestId,
  });
  return rowToEndpoint(r.rows[0]);
}

export async function setEndpointActive(
  client: PoolClient,
  input: { tenantId: string; endpointId: string; active: boolean; actor: string },
): Promise<WebhookEndpoint> {
  const r = await client.query(
    `UPDATE webhook_endpoints
        SET active = $3, failing_since = NULL, disabled_reason = NULL, updated_at = now()
      WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [input.tenantId, input.endpointId, input.active],
  );
  if (r.rowCount === 0) throw new Error('No encontramos ese webhook.');
  return rowToEndpoint(r.rows[0]);
}

export async function deleteEndpoint(
  client: PoolClient,
  input: { tenantId: string; endpointId: string; actor: string },
): Promise<void> {
  const r = await client.query(
    'DELETE FROM webhook_endpoints WHERE tenant_id = $1 AND id = $2',
    [input.tenantId, input.endpointId],
  );
  if (r.rowCount === 0) throw new Error('No encontramos ese webhook.');
}

/** El consumer del outbox: encola la entrega para CADA endpoint suscrito
 *  del tenant del evento. Idempotente por (endpoint, evento). */
export async function enqueueDeliveries(event: EventEnvelope, client: PoolClient): Promise<void> {
  const endpoints = await client.query(
    `SELECT id FROM webhook_endpoints
      WHERE tenant_id = $1 AND active AND events @> to_jsonb(ARRAY[$2]::text[])`,
    [event.tenantId, event.name],
  );
  for (const fila of endpoints.rows) {
    await client.query(
      `INSERT INTO webhook_deliveries (tenant_id, endpoint_id, event_id, event_name, payload)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (endpoint_id, event_id) DO NOTHING`,
      [
        event.tenantId,
        fila.id,
        event.id,
        event.name,
        JSON.stringify({
          id: event.id,
          name: event.name,
          occurredAt: event.occurredAt,
          data: event.payload,
        }),
      ],
    );
  }
}

/** Los consumers para el despachador: uno por evento del catálogo. */
export function webhookConsumers(eventNames: string[]): Consumer[] {
  return eventNames.map((event) => ({
    name: `integrations.wh.${event}`,
    moduleId: 'integrations',
    event,
    handler: enqueueDeliveries,
  }));
}

export interface Delivery {
  id: string;
  endpointId: string;
  eventName: string;
  payload: unknown;
  attempt: number;
  status: 'pending' | 'ok' | 'failed';
  responseStatus: number | null;
  responseBody: string | null;
  nextRetryAt: Date | null;
  deliveredAt: Date | null;
  createdAt: Date;
}

function rowToDelivery(row: Record<string, unknown>): Delivery {
  return {
    id: row.id as string,
    endpointId: row.endpoint_id as string,
    eventName: row.event_name as string,
    payload: row.payload,
    attempt: Number(row.attempt),
    status: row.status as Delivery['status'],
    responseStatus: row.response_status === null ? null : Number(row.response_status),
    responseBody: (row.response_body as string) ?? null,
    nextRetryAt: (row.next_retry_at as Date) ?? null,
    deliveredAt: (row.delivered_at as Date) ?? null,
    createdAt: row.created_at as Date,
  };
}

export async function listDeliveries(
  client: PoolClient,
  tenantId: string,
  endpointId?: string,
): Promise<Delivery[]> {
  const r = await client.query(
    `SELECT * FROM webhook_deliveries
      WHERE tenant_id = $1 AND ($2::uuid IS NULL OR endpoint_id = $2)
      ORDER BY created_at DESC LIMIT 50`,
    [tenantId, endpointId ?? null],
  );
  return r.rows.map(rowToDelivery);
}

/** Reintento manual desde el panel: vuelve a pending, al tiro. */
export async function retryDelivery(
  client: PoolClient,
  input: { tenantId: string; deliveryId: string },
): Promise<void> {
  const r = await client.query(
    `UPDATE webhook_deliveries
        SET status = 'pending', next_retry_at = now(), attempt = GREATEST(attempt - 1, 0)
      WHERE tenant_id = $1 AND id = $2 AND status = 'failed'`,
    [input.tenantId, input.deliveryId],
  );
  if (r.rowCount === 0) throw new Error('Esa entrega no está fallida (solo las fallidas se reintentan a mano).');
}

const FALLOS_SOSTENIDOS_HORAS = 24;

/**
 * El barrido de entregas (cada minuto, cola scheduled): firma, POST con
 * timeout, backoff exponencial, y el endpoint que falla sostenido se
 * APAGA con aviso (webhook.failed) — no se pierde nadie en silencio.
 */
export async function deliverWebhooks(
  pool: Pool,
  fetcher: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<{ delivered: number; failed: number }> {
  const res = { delivered: 0, failed: 0 };
  // Por tenant y no de una sola pasada (#286): `webhook_deliveries` tiene
  // RLS, así que una consulta suelta devuelve cero filas con el rol de
  // producción. El tope de 100 pasa a ser por tenant, que además reparte
  // mejor: antes un tenant con mucha cola se comía el turno de los demás.
  const vencidas = { rows: [] as Array<{ id: string; tenant_id: string }> };
  await porCadaTenant(
    pool,
    async (client, tenantId) => {
    // `tenant_id = $1` explícito y no solo RLS: la regla del proyecto es
    // que RLS es la SEGUNDA cerradura, no la primera. Sin el filtro, con el
    // rol de desarrollo —superusuario— esta consulta devolvía las entregas
    // de TODOS los tenants en cada vuelta. Lo cazó un test.
    const r = await client.query(
      `SELECT id FROM webhook_deliveries
        WHERE tenant_id = $1 AND status = 'pending' AND next_retry_at <= now()
        ORDER BY next_retry_at LIMIT 100`,
      [tenantId],
    );
      for (const x of r.rows) vencidas.rows.push({ id: x.id as string, tenant_id: tenantId });
    },
    {
      // Una cuenta suspendida no manda NADA hacia afuera, y los webhooks
      // eran el único camino de salida que no lo respetaba.
      //
      // Los mensajes al cliente pasan por la cola, y ahí `puedeEnviar`
      // bloquea `suspended` y `deleted` — "este es el único lugar por donde
      // pasa TODO lo que sale", dice el worker. Los webhooks no pasan por
      // ahí: un evento inserta la entrega y este barrido la manda, sin que
      // nadie mire en qué estado está el negocio.
      //
      // `read_only` SÍ sigue recibiendo: §6 restringe los mensajes que
      // INICIA el negocio, no que sus integraciones se mantengan al día.
      // Cortarle el sincronizado de su CRM por un atraso en el pago sería
      // castigar más de lo que la regla dice.
      //
      // `deleted` ya queda fuera: `idsDeTenants` lo excluye por defecto.
      estados: ['trial', 'active', 'past_due', 'read_only'],
    },
  );
  for (const fila of vencidas.rows) {
    await withTenant(pool, fila.tenant_id, async (client) => {
      const d = await client.query(
        `SELECT d.*, e.url, e.secret, e.active FROM webhook_deliveries d
           JOIN webhook_endpoints e ON e.id = d.endpoint_id
          WHERE d.id = $1 FOR UPDATE SKIP LOCKED`,
        [fila.id],
      );
      if (d.rowCount === 0) return;
      const entrega = d.rows[0];
      if (!entrega.active) {
        await client.query(
          `UPDATE webhook_deliveries SET status = 'failed', response_body = 'endpoint apagado' WHERE id = $1`,
          [fila.id],
        );
        return;
      }
      const body = JSON.stringify(entrega.payload);
      let status: number | null = null;
      let respuesta = '';
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const r = await fetcher(entrega.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Iaxti-Signature': signPayload(entrega.secret, body),
            'X-Iaxti-Event': entrega.event_name,
          },
          body,
          signal: controller.signal,
        });
        clearTimeout(timer);
        status = r.status;
        respuesta = (await r.text().catch(() => '')).slice(0, 500);
      } catch (err) {
        respuesta = String((err as Error).message).slice(0, 500);
      }

      if (status !== null && status >= 200 && status < 300) {
        await client.query(
          `UPDATE webhook_deliveries
              SET status = 'ok', response_status = $2, response_body = $3,
                  attempt = attempt + 1, delivered_at = now()
            WHERE id = $1`,
          [fila.id, status, respuesta],
        );
        await client.query(
          `UPDATE webhook_endpoints SET failing_since = NULL WHERE id = $1`,
          [entrega.endpoint_id],
        );
        res.delivered += 1;
        return;
      }

      const intento = Number(entrega.attempt) + 1;
      const agotada = intento >= MAX_ATTEMPTS;
      await client.query(
        `UPDATE webhook_deliveries
            SET status = $2, response_status = $3, response_body = $4, attempt = $5,
                next_retry_at = now() + make_interval(mins => $6)
          WHERE id = $1`,
        [fila.id, agotada ? 'failed' : 'pending', status, respuesta, intento, backoffMinutes(intento)],
      );
      await client.query(
        `UPDATE webhook_endpoints SET failing_since = COALESCE(failing_since, now()) WHERE id = $1`,
        [entrega.endpoint_id],
      );
      res.failed += 1;

      // Falla sostenida: se apaga con aviso — el cliente se entera.
      const endpoint = await client.query(
        `SELECT failing_since FROM webhook_endpoints WHERE id = $1`,
        [entrega.endpoint_id],
      );
      const desde = endpoint.rows[0]?.failing_since as Date | null;
      if (
        agotada &&
        desde &&
        Date.now() - new Date(desde).getTime() > FALLOS_SOSTENIDOS_HORAS * 3_600_000
      ) {
        await client.query(
          `UPDATE webhook_endpoints
              SET active = false, disabled_reason = 'falló sostenido por más de 24 horas', updated_at = now()
            WHERE id = $1 AND active`,
          [entrega.endpoint_id],
        );
        await publishEvent(client, {
          name: 'webhook.failed',
          tenantId: fila.tenant_id,
          payload: { endpointId: entrega.endpoint_id, url: entrega.url },
          actor: 'system',
        });
      }
    });
  }
  return res;
}
