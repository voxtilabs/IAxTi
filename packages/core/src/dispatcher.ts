import type { Pool, PoolClient } from 'pg';
import type { ModuleRegistry } from './registry';
import type { EventEnvelope } from './events';

export type EventHandler = (event: EventEnvelope, client: PoolClient) => Promise<void>;

export interface Consumer {
  /** Nombre estable del consumidor: clave de idempotencia en processed_events. */
  name: string;
  /** Módulo dueño: si está apagado, sus consumos se saltan (SPEC §26 regla 5). */
  moduleId: string;
  /** Nombre del evento del catálogo (SPEC §24). */
  event: string;
  handler: EventHandler;
}

/**
 * Reintentos antes de abandonar un evento. Se exporta porque quien vigila
 * los abandonados (el tablero de salud, #71) tiene que usar EL MISMO
 * número: dos definiciones y el panel miente.
 */
export const MAX_ATTEMPTS = 5;

/**
 * Despachador del outbox: corre en workers, procesa por lotes con
 * FOR UPDATE SKIP LOCKED (varios workers no se pisan), entrega a cada
 * consumidor UNA sola vez (processed_events) y reintenta ante fallo hasta
 * MAX_ATTEMPTS, dejando el error registrado.
 */
export class OutboxDispatcher {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly registry: ModuleRegistry,
    private readonly consumers: Consumer[],
    private readonly batchSize = 50,
  ) {}

  /** Procesa un lote pendiente. Devuelve cuántos eventos quedaron procesados. */
  async tick(): Promise<number> {
    const client = await this.pool.connect();
    let processed = 0;
    try {
      await client.query('BEGIN');
      const pending = await client.query(
        `SELECT id, name, tenant_id, payload, actor, request_id, version, occurred_at
           FROM outbox
          WHERE processed_at IS NULL AND attempts < $1
          ORDER BY id
          LIMIT $2
          FOR UPDATE SKIP LOCKED`,
        [MAX_ATTEMPTS, this.batchSize],
      );

      for (const row of pending.rows) {
        const event: EventEnvelope = {
          id: Number(row.id),
          name: row.name,
          tenantId: row.tenant_id,
          payload: row.payload,
          actor: row.actor,
          requestId: row.request_id,
          version: row.version,
          occurredAt: row.occurred_at,
        };

        await client.query(`SAVEPOINT evento`);
        try {
          for (const consumer of this.consumers) {
            if (consumer.event !== event.name) continue;
            if (!this.registry.isActive(consumer.moduleId)) continue; // módulo apagado: se salta

            const claim = await client.query(
              `INSERT INTO processed_events (consumer, event_id) VALUES ($1, $2)
               ON CONFLICT DO NOTHING`,
              [consumer.name, event.id],
            );
            if (claim.rowCount === 0) continue; // ya entregado: idempotente

            await consumer.handler(event, client);
          }
          await client.query(
            'UPDATE outbox SET processed_at = now(), attempts = attempts + 1 WHERE id = $1',
            [event.id],
          );
          processed += 1;
        } catch (error) {
          await client.query('ROLLBACK TO SAVEPOINT evento');
          await client.query(
            'UPDATE outbox SET attempts = attempts + 1, last_error = $2 WHERE id = $1',
            [event.id, (error as Error).message],
          );
        }
      }
      await client.query('COMMIT');
      return processed;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  start(intervalMs = 500): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error) => console.error('outbox tick falló:', error));
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
