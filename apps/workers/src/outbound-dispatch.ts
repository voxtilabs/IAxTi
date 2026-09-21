import Redis from 'ioredis';
import { createQueue, type Consumer, type ModuleRegistry } from '@iaxti/core';
import { conTrazaDelJob } from '@iaxti/telemetry';

export interface OutboundRequestJob {
  moduleId: 'whatsapp';
  tenantId: string;
  messageId: string;
  requestId?: string;
  initiatedByBusiness: boolean;
  transaccional?: true;
}

/** Solo publica trabajos. Nunca llama al proveedor ni cambia su estado de entrega. */
export function outboundRequestConsumers(
  enqueue: (job: OutboundRequestJob) => Promise<void>,
  registry: Pick<ModuleRegistry, 'isActive'>,
): Consumer[] {
  return [{
    name: 'conversations.delivery_to_outbound', moduleId: 'conversations',
    event: 'message.delivery_requested', disabled: 'retry',
    handler: async event => {
      const { messageId, policy } = event.payload;
      if (event.version !== 1 || typeof messageId !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(messageId) ||
          typeof policy !== 'string' || !['reply', 'business', 'transactional'].includes(policy)) {
        throw new Error('El pedido durable de salida no tiene un formato válido.');
      }
      if (!registry.isActive('whatsapp')) {
        throw new Error('El módulo de salida está apagado; el pedido sigue pendiente.');
      }
      const trace = event.payload.__traza as { traceparent?: unknown } | undefined;
      const traceparent = typeof trace?.traceparent === 'string' &&
        /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(trace.traceparent) ? trace.traceparent : undefined;
      await conTrazaDelJob(traceparent ? { traceparent } : undefined, 'outbox delivery', {
        'iaxti.tenant_id': event.tenantId, 'iaxti.request_id': event.requestId ?? undefined,
      }, () => enqueue({
        moduleId: 'whatsapp', tenantId: event.tenantId, messageId,
        requestId: event.requestId ?? undefined,
        initiatedByBusiness: policy !== 'reply',
        ...(policy === 'transactional' ? { transaccional: true as const } : {}),
      }));
    },
  }];
}

/** Conexión exclusiva del publicador: un Redis caído no retiene el lote indefinidamente. */
export function createOutboundPublisher(url: string | undefined, timeoutMs = 2_000) {
  type Connection = { redis: Redis; queue: ReturnType<typeof createQueue> };
  let current: Connection | undefined;
  let retryAfter = 0;
  const unavailable = 'No pudimos pasar el mensaje a Redis; el pedido sigue en el outbox.';
  const discard = (connection: Connection) => {
    if (current === connection) current = undefined;
    connection.redis.disconnect();
    return connection.queue.close().catch(() => {});
  };
  return {
    async enqueue(job: OutboundRequestJob): Promise<void> {
      if (!url) throw new Error('Redis no está configurado; el pedido sigue en el outbox.');
      // Un lote trae hasta 50 eventos. Tras un fallo no debe esperar otros
      // dos segundos por CADA mensaje mientras sostiene bloqueos PostgreSQL.
      if (Date.now() < retryAfter) throw new Error(unavailable);
      if (!current) {
        const redis = new Redis(url, {
          maxRetriesPerRequest: 1, enableOfflineQueue: false,
          connectTimeout: timeoutMs, retryStrategy: null,
        });
        redis.on('error', () => {}); // El error acotado y sin secretos se conserva en outbox.
        const queue = createQueue('outbound', redis);
        queue.on('error', () => {});
        current = { redis, queue };
      }
      const connection = current;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async () => {
            await connection.queue.waitUntilReady();
            await connection.queue.add('send', job, { jobId: `out-${job.messageId}` });
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Plazo de publicación agotado.')), timeoutMs);
          }),
        ]);
      } catch {
        // Puede haber llegado a Redis antes del timeout: el reintento usa
        // el mismo jobId y processOutbound comprueba mensajes ya entregados.
        void discard(connection);
        retryAfter = Date.now() + 1_000;
        throw new Error(unavailable);
      } finally { if (timer) clearTimeout(timer); }
    },
    async close(): Promise<void> {
      if (current) await discard(current);
    },
  };
}
