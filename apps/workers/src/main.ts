import './instrument';
import { createServer } from 'node:http';
import { createPool, exigeRolQueRespetaRls, withTenant } from '@iaxti/db';
import { DelayedError } from 'bullmq';
import {
  ModuleRegistry,
  OutboxDispatcher,
  createModuleWorker,
  createQueue,
  limpiarLlavesVencidas,
  redisConnection,
  storageFromEnv,
} from '@iaxti/core';
import { processInbound, type InboundJob } from './inbound';
import { DelayUntilError, processOutbound } from './outbound';
import { processDeliveryStatuses, type DeliveryStatusJob } from './delivery';
import { processQualityUpdates, type QualityUpdateJob } from './quality';
import { processSuggest, type SuggestJob } from './copilot';
import { realtimeConsumers } from './realtime';
import { deleteR2Keys, onContactMerged, purgeTenantRetention, retentionConsumers, tenantsWithRetention } from '@iaxti/module-conversations';
import { notificationConsumers } from '@iaxti/module-notifications';
import { barrerRecordatorios } from '@iaxti/module-calendar';
import { onboardingConsumers } from '@iaxti/module-organizations';
import { transportesDeAviso } from './transportes-aviso';
import {
  enqueueTenantChildren,
  runArchiveTenant,
  runAutoResolveTenant,
  sweepConversationAlerts,
  sweepDueActivities,
} from './sweeps';
import { sincronizarPlantillas } from './plantillas-sync';
import { expireSources, tenantsWithExpirable } from '@iaxti/module-knowledge';
import { automationConsumers, sequenceConsumers, sweepSequences, sweepTimeRules, type EngineDeps } from '@iaxti/module-automations';
import { analyticsConsumers, sweepResponseSamples } from '@iaxti/module-analytics';
import { expireLinks, tenantsWithExpirableLinks } from '@iaxti/module-payments';
import { billingConsumers, sweepBilling } from '@iaxti/module-billing';
import { applyModuleFlags } from '@iaxti/module-platform';
import { flushApiUsage } from './api-usage';
import { deliverWebhooks, webhookConsumers } from '@iaxti/module-integrations';
import { processPaymentWebhook, type PaymentWebhookJob } from './payments';

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
  // Igual que la API (issue 211): un rol que se salta RLS no sirve. Los
  // workers escriben en nombre de cada tenant, así que acá importa lo mismo.
  // Grita si la conexión no respeta RLS; no se mata solo (issue 227: lo
  // correcto es negarse a trabajar con el proceso vivo, no desaparecer).
  void exigeRolQueRespetaRls(pool).catch((err) => {
    console.error(`workers: ${(err as Error).message}`);
  });

  // El motor de reglas (#62): consumidores de eventos + barrido de tiempo.
  // enqueueOutbound se conecta más abajo, cuando la cola outbound exista.
  const automationDeps: EngineDeps = {
    activeModules: ['conversations', 'crm'].filter((m) => registry.isActive(m)),
  };
  const dispatcher = new OutboxDispatcher(pool, registry, [
    ...automationConsumers(automationDeps),
    // El corte de secuencias (#63): responde el cliente o se mueve el deal.
    ...sequenceConsumers(),
    // El dashboard del dueño (#66): contadores por día, POR EVENTO.
    ...analyticsConsumers(),
    // Facturas pagadas (#67): el tenant vuelve de past_due solo.
    ...billingConsumers(),
    // Webhooks salientes (#76): cada evento del catálogo puede salir.
    ...webhookConsumers(registry.eventsCatalog()),
    ...realtimeConsumers(),
    // Fusión de contactos (#34): la bandeja re-apunta su historia.
    {
      name: 'conversations.contact_merged',
      moduleId: 'conversations',
      event: 'contact.merged',
      handler: onContactMerged,
    },
    // La campana y el correo (#55): consumidores idempotentes del catálogo.
    ...notificationConsumers(transportesDeAviso(pool)),
    // Bajar de plan reduce retención: purga diferida 30 días con aviso (#77).
    ...retentionConsumers(),
    // El onboarding avanza con lo que de verdad pasa (SPEC §7): la máquina
    // existía entera y no la movía nadie.
    ...onboardingConsumers(),
  ]);
  dispatcher.start(500);
  console.log('workers: despachador de outbox activo (500 ms)');

  // Flags de módulos SIN desplegar (#69): al arrancar y cada 60 s.
  void applyModuleFlags(pool, registry).catch(() => {});
  setInterval(() => void applyModuleFlags(pool, registry).catch(() => {}), 60_000).unref?.();

  if (process.env.REDIS_URL) {
    const scheduled = createQueue('scheduled', redisConnection());
    const redisScheduled = redisConnection();
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
          // Retención por plan (#77): padre → hijo por tenant activo con
          // retención finita; R2 se borra TRAS el commit, idempotente.
          case 'conversations.retention': {
            const ids = await tenantsWithRetention(pool);
            for (const tenantId of ids) {
              await scheduled.add('conversations.retention.tenant', { moduleId: 'conversations', tenantId });
            }
            return { tenants: ids.length };
          }
          case 'conversations.retention.tenant': {
            const res = await purgeTenantRetention(pool, (job.data as { tenantId: string }).tenantId);
            if (!res) return { purged: 0 };
            const storage = storageFromEnv();
            const r2 = storage ? await deleteR2Keys(storage, res.r2Keys) : { deleted: 0, failed: res.r2Keys.length };
            console.log(`retention: ${res.purged} conversaciones purgadas (corte ${res.cutoff}, ${r2.deleted} adjuntos R2)`);
            return { purged: res.purged, r2 };
          }
          // El barrido de tiempo del motor (#62): "2 días en etapa",
          // "sin respuesta hace 24 h" — dedupe por objeto y día.
          case 'automations.sweep': {
            const n = await sweepTimeRules(pool, automationDeps);
            const pasos = await sweepSequences(pool, automationDeps);
            if (n + pasos > 0) console.log(`scheduled: ${n} reglas y ${pasos} pasos de secuencia`);
            return { ran: n, steps: pasos };
          }
          // Plantillas colgadas (#44): si se perdió el webhook de Meta, la
          // plantilla se queda "en revisión" para siempre. Se pregunta.
          case 'whatsapp.templates.sync': {
            const r = await sincronizarPlantillas(pool);
            if (r.cambiadas > 0) console.log(`plantillas: ${r.cambiadas} resueltas de ${r.revisadas} en revisión`);
            return r;
          }
          // Muestras de primera respuesta (#66): mediana/p90 sin barrer en vivo.
          case 'analytics.response_samples': {
            const n = await sweepResponseSamples(pool);
            if (n > 0) console.log(`scheduled: ${n} muestras de primera respuesta`);
            return { sampled: n };
          }
          // El consumo de API (#26): de Redis a usage_meters/daily_metrics.
          // Las llaves de idempotencia viven 24 h (SPEC §28): pasado eso,
          // el mismo pedido vuelve a ser un pedido nuevo.
          case 'idempotency.sweep': {
            const tenants = await pool.query("SELECT id FROM tenants WHERE state <> 'deleted'");
            let borradas = 0;
            for (const fila of tenants.rows) {
              borradas += await withTenant(pool, fila.id as string, (c) => limpiarLlavesVencidas(c));
            }
            if (borradas > 0) console.log(`scheduled: ${borradas} llaves de idempotencia vencidas`);
            return { borradas };
          }
          // Recordatorios de cita (#59): 24 h y 2 h antes, por plantilla.
          // El horario de silencio lo aplica la cola, no esto.
          case 'calendar.reminders': {
            const res = await barrerRecordatorios(pool, {
              enviar: async () => ({
                enviado: false,
                // Mandar el recordatorio necesita una plantilla aprobada
                // (#44) y el número conectado. Mientras no estén, se dice
                // por qué en vez de fingir que salió.
                motivo: 'falta la plantilla aprobada del recordatorio',
              }),
            });
            if (res.enviados + res.saltados > 0) {
              console.log(`scheduled: recordatorios ${res.enviados} enviados, ${res.saltados} sin salir`);
            }
            return res;
          }
          case 'api_usage.flush': {
            const n = await flushApiUsage(pool, redisScheduled);
            if (n > 0) console.log(`scheduled: ${n} contadores de API volcados`);
            return { flushed: n };
          }
          // Entregas de webhooks (#76): firma, backoff y apagado con aviso.
          case 'webhooks.deliver': {
            const res = await deliverWebhooks(pool);
            if (res.delivered + res.failed > 0) {
              console.log(`scheduled: webhooks — ${res.delivered} entregados, ${res.failed} con reintento`);
            }
            return res;
          }
          // El ciclo de cobro (#67): facturas, impagos y estados del tenant.
          case 'billing.sweep': {
            const res = await sweepBilling(pool);
            if (res.issued + res.overdue + res.readOnly > 0) {
              console.log(`scheduled: billing — ${res.issued} facturas, ${res.overdue} impagas, ${res.readOnly} read_only`);
            }
            return res;
          }
          // Links vencidos (#60): created/sent con la fecha pasada.
          case 'payments.expire': {
            const conVencibles = await tenantsWithExpirableLinks(pool);
            let total = 0;
            for (const tenantId of conVencibles) {
              total += await withTenant(pool, tenantId, (c) => expireLinks(c, tenantId));
            }
            if (total > 0) console.log(`scheduled: ${total} links de pago vencidos`);
            return { expired: total };
          }
          // Vigencias del conocimiento (#51): vencida, la IA la ignora y avisa.
          case 'knowledge.expire': {
            const conVencibles = await tenantsWithExpirable(pool);
            let total = 0;
            for (const tenantId of conVencibles) {
              total += await withTenant(pool, tenantId, (c) => expireSources(c, tenantId));
            }
            if (total > 0) console.log(`scheduled: ${total} fuentes de conocimiento vencidas`);
            return { expired: total };
          }
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
      scheduled.add(
        'conversations.retention',
        { moduleId: 'conversations' },
        { repeat: { pattern: '0 4 * * *', tz: 'America/Santiago' } },
      ),
      scheduled.add(
        'knowledge.expire',
        { moduleId: 'knowledge' },
        { repeat: { pattern: '30 * * * *', tz: 'America/Santiago' } },
      ),
      scheduled.add(
        'automations.sweep',
        { moduleId: 'automations' },
        { repeat: { every: 300_000 } },
      ),
      scheduled.add(
        'analytics.response_samples',
        { moduleId: 'analytics' },
        { repeat: { pattern: '15 * * * *', tz: 'America/Santiago' } },
      ),
      scheduled.add(
        'payments.expire',
        { moduleId: 'payments' },
        { repeat: { pattern: '45 * * * *', tz: 'America/Santiago' } },
      ),
      scheduled.add(
        'billing.sweep',
        { moduleId: 'billing' },
        { repeat: { pattern: '0 4 * * *', tz: 'America/Santiago' } },
      ),
      scheduled.add(
        'api_usage.flush',
        { moduleId: 'organizations' },
        { repeat: { every: 300_000 } },
      ),
      scheduled.add(
        'calendar.reminders',
        { moduleId: 'calendar' },
        { repeat: { every: 900_000 } },
      ),
      scheduled.add(
        'idempotency.sweep',
        // `organizations`, no 'core': el registro solo conoce módulos, y
        // `isActive('core')` es false — el barrido no habría corrido nunca.
        { moduleId: 'organizations' },
        { repeat: { pattern: '20 * * * *', tz: 'America/Santiago' } },
      ),
      scheduled.add(
        'whatsapp.templates.sync',
        { moduleId: 'whatsapp' },
        // Meta tarda de minutos a 24 h en revisar. Cada 30 min alcanza de
        // sobra y no castiga al proveedor con preguntas cada minuto.
        { repeat: { every: 1_800_000 } },
      ),
      scheduled.add(
        'webhooks.deliver',
        { moduleId: 'integrations' },
        { repeat: { every: 60_000 } },
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
        // La confirmación de pagos (#61): verificada y fuera de línea.
        if (job.name === 'payment-webhook') {
          // Con la cola de salida: el aviso de "pago recibido" se escribía
          // en la bandeja marcado como enviado y nunca salía al cliente.
          // Va como iniciado por el negocio, así que respeta el horario de
          // silencio igual que el resto.
          return processPaymentWebhook(pool, job.data as unknown as PaymentWebhookJob, fetch, {
            enqueueOutbound: (j) => encolarSalida({ ...j, transaccional: true }),
          });
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
                knowledgeActivo: registry.isActive('knowledge'),
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

    // La cola agents (#48/#49): sugerencias, transcripciones y el modo
    // autónomo del copiloto; sus salientes van por la MISMA cola outbound.
    const outboundQueue = createQueue('outbound', redisConnection());
    const encolarSalida = async (job: {
      tenantId: string;
      messageId: string;
      requestId?: string;
      transaccional?: boolean;
    }) => {
      await outboundQueue.add(
        'send',
        {
          moduleId: 'whatsapp',
          tenantId: job.tenantId,
          messageId: job.messageId,
          requestId: job.requestId,
          // El comprobante de pago se salta el silencio y nada más
          // (ADR-0016). Todo lo demás espera al horario válido.
          ...(job.transaccional ? { transaccional: true } : {}),
          // Automatizaciones y secuencias las inicia el negocio: pasan por el
          // horario de silencio y por la pausa de calidad.
          initiatedByBusiness: true,
        },
        { jobId: `out-${job.messageId}` },
      );
    };
    // El motor de reglas y las secuencias encolan por acá: nada de lo suyo
    // es transaccional, así que todo respeta el silencio.
    automationDeps.enqueueOutbound = encolarSalida;

    createModuleWorker(
      'agents',
      registry,
      async (job) => processSuggest(pool, job.data as unknown as SuggestJob, { outbound: outboundQueue, registry }),
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

// `/health` es "el proceso vive" —si falla, REINICIAN— y por eso no mira
// dependencias. `/ready` es "puede trabajar ahora": para un consumidor de
// colas eso significa Redis, que es de lo que vive. Decir que sí sin
// mirarlo deja al orquestador creyendo que la instancia trabaja cuando no
// está consumiendo nada (#17).
const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service }));
    return;
  }
  if (req.url === '/ready') {
    void (async () => {
      if (!process.env.REDIS_URL) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', service, redis: 'sin configurar' }));
        return;
      }
      const sonda = redisConnection();
      try {
        await sonda.ping();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', service, redis: 'ok' }));
      } catch (err) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'degraded', service, redis: (err as Error).message }));
      } finally {
        void sonda.quit().catch(() => {});
      }
    })();
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ code: 'NOT_FOUND', message: 'Nada por aquí todavía.', requestId: '', details: [] }));
});

server.listen(port, () => start());
