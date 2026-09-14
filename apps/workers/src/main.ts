import './instrument';
import { createServer } from 'node:http';
import { createPool } from '@iaxti/db';
import { DelayedError } from 'bullmq';
import {
  ModuleRegistry,
  OutboxDispatcher,
  createModuleWorker,
  createQueue,
  redisConnection,
} from '@iaxti/core';
import { processInbound, type InboundJob } from './inbound';
import { DelayUntilError, processOutbound } from './outbound';
import { processDeliveryStatuses, type DeliveryStatusJob } from './delivery';
import { processQualityUpdates, type QualityUpdateJob } from './quality';
import { processSuggest, type SuggestJob } from './copilot';
import { realtimeConsumers } from './realtime';
import { onContactMerged } from '@iaxti/module-conversations';
import { notificationConsumers } from '@iaxti/module-notifications';
import {
  enqueueTenantChildren,
  runArchiveTenant,
  runAutoResolveTenant,
  sweepConversationAlerts,
  sweepDueActivities,
} from './sweeps';

const service = process.env.SERVICE ?? 'workers';
const port = Number(process.env.PORT ?? 3000);

// Los consumidores reales se registran módulo a módulo en sus issues; el
// despachador y las colas quedan operativos desde ya (issue #13).
function start(): void {
  if (!process.env.DATABASE_URL) {
    console.log('workers: sin DATABASE_URL; outbox y colas esperan configuración');
    return;
  }
  const registry = new ModuleRegistry().load();
  const pool = createPool();

  const dispatcher = new OutboxDispatcher(pool, registry, [
    ...realtimeConsumers(),
    // Fusión de contactos (#34): la bandeja re-apunta su historia.
    {
      name: 'conversations.contact_merged',
      moduleId: 'conversations',
      event: 'contact.merged',
      handler: onContactMerged,
    },
    // La campana y el correo (#55): consumidores idempotentes del catálogo.
    ...notificationConsumers(),
  ]);
  dispatcher.start(500);
  console.log('workers: despachador de outbox activo (500 ms)');

  if (process.env.REDIS_URL) {
    const scheduled = createQueue('scheduled', redisConnection());
    createModuleWorker(
      'scheduled',
      registry,
      async (job) => {
        switch (job.name) {
          case 'conversations.checks': {
            const res = await sweepConversationAlerts(pool);
            if (res.unattended || res.breached) {
              console.log(
                `scheduled: alertas de bandeja — ${res.unattended} sin dueño, ${res.breached} SLA vencido (${res.tenants} tenants)`,
              );
            }
            return res;
          }
          case 'crm.activities_due': {
            const res = await sweepDueActivities(pool);
            if (res.due) console.log(`scheduled: ${res.due} actividades vencidas avisadas`);
            return res;
          }
          // Patrón §39: padre encola un hijo por tenant.
          case 'conversations.auto_resolve':
            return { tenants: await enqueueTenantChildren(pool, scheduled, 'conversations.auto_resolve') };
          case 'conversations.archive':
            return { tenants: await enqueueTenantChildren(pool, scheduled, 'conversations.archive') };
          case 'conversations.auto_resolve.tenant':
            return runAutoResolveTenant(pool, (job.data as { tenantId: string }).tenantId);
          case 'conversations.archive.tenant':
            return runArchiveTenant(pool, (job.data as { tenantId: string }).tenantId);
          default:
            console.log(`scheduled: job ${job.name} procesado`);
            return { ok: true };
        }
      },
      redisConnection(),
    );
    // Repetibles (§39, zona America/Santiago): avisos cada minuto, cierre
    // automático cada hora, archivo diario a las 03:00. add repetido con la
    // misma pauta es idempotente entre reinicios.
    void Promise.all([
      scheduled.add('conversations.checks', { moduleId: 'conversations' }, { repeat: { every: 60_000 } }),
      scheduled.add('crm.activities_due', { moduleId: 'crm' }, { repeat: { every: 60_000 } }),
      scheduled.add(
        'conversations.auto_resolve',
        { moduleId: 'conversations' },
        { repeat: { pattern: '0 * * * *', tz: 'America/Santiago' } },
      ),
      scheduled.add(
        'conversations.archive',
        { moduleId: 'conversations' },
        { repeat: { pattern: '0 3 * * *', tz: 'America/Santiago' } },
      ),
    ]).catch((err) => console.error('scheduled: no se pudieron programar los repetibles', err));
    console.log('workers: worker de cola scheduled activo');

    // El camino de entrada de mensajes (#35/#36): simulador y WhatsApp por
    // la misma cola. Los estados de entrega del webhook llegan aquí también.
    const agentsQueue = createQueue('agents', redisConnection());
    createModuleWorker(
      'inbound',
      registry,
      async (job) => {
        if (job.name === 'delivery-status') {
          return processDeliveryStatuses(pool, job.data as unknown as DeliveryStatusJob);
        }
        if (job.name === 'quality-update') {
          return processQualityUpdates(pool, job.data as unknown as QualityUpdateJob);
        }
        const data = job.data as unknown as InboundJob;
        const res = await processInbound(pool, data);
        // El copiloto (#48) corre DESPUÉS, en su cola: la bandeja no espera.
        if (registry.isActive('agents') && !res.optedOut) {
          const adjunto = (data.attachments as Array<{ key?: string; contentType?: string }> | undefined)?.[0];
          await agentsQueue
            .add(
              'suggest',
              {
                moduleId: 'agents',
                tenantId: data.tenantId,
                conversationId: res.conversationId,
                messageId: res.messageId,
                audioKey: data.type === 'audio' ? adjunto?.key : undefined,
                audioType: adjunto?.contentType,
                requestId: data.requestId,
              },
              { jobId: `sg-${res.messageId}` },
            )
            .catch(() => {});
        }
        return res;
      },
      redisConnection(),
    );
    console.log('workers: worker de cola inbound activo');

    // La cola agents (#48): sugerencias y transcripciones del copiloto.
    createModuleWorker(
      'agents',
      registry,
      async (job) => processSuggest(pool, job.data as unknown as SuggestJob),
      redisConnection(),
    );
    console.log('workers: worker de cola agents activo');

    // La salida de WhatsApp (#43): rate limit por número, backoff de BullMQ,
    // silencio del tenant para lo iniciado por el negocio.
    const redisOutbound = redisConnection();
    createModuleWorker(
      'outbound',
      registry,
      async (job, token) => {
        try {
          return await processOutbound(pool, redisOutbound, job as never);
        } catch (err) {
          if (err instanceof DelayUntilError) {
            // El patrón oficial de BullMQ para reprogramar desde el procesador.
            await job.moveToDelayed(Date.now() + err.ms, token);
            throw new DelayedError();
          }
          throw err;
        }
      },
      redisConnection(),
    );
    console.log('workers: worker de cola outbound activo');
  } else {
    console.log('workers: sin REDIS_URL; colas BullMQ esperan configuración');
  }
}

const server = createServer((req, res) => {
  if (req.url === '/health' || req.url === '/ready') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ code: 'NOT_FOUND', message: 'Nada por aquí todavía.', requestId: '', details: [] }));
});

server.listen(port, () => start());
