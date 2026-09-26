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
  consumerReadiness,
  storageFromEnv,
  enteroDeEntorno,
} from '@iaxti/core';
import { processInbound, type InboundJob } from './inbound';
import { DelayUntilError, processOutbound } from './outbound';
import { createOutboundPublisher, outboundRequestConsumers } from './outbound-dispatch';
import { processDeliveryStatuses, type DeliveryStatusJob } from './delivery';
import { processQualityUpdates, type QualityUpdateJob } from './quality';
import { realtimeConsumers } from './realtime';
import {
  deleteR2Keys,
  onContactMerged,
  purgeTenantRetention,
  retentionConsumers,
  sendMessage,
  tenantsWithRetention,
} from '@iaxti/module-conversations';
import { notificationConsumers } from '@iaxti/module-notifications';
import {
  barrerRecordatorios,
  configuracionDeAvisos,
  valoresDelAviso,
} from '@iaxti/module-calendar';
import { getTenantSettings, onboardingConsumers } from '@iaxti/module-organizations';
import { objetivoConsumers } from '@iaxti/module-agents';
import { transportesDeAviso } from './transportes-aviso';
import {
  enqueueTenantChildren,
  runArchiveTenant,
  runAutoResolveTenant,
  sweepConversationAlerts,
  sweepDueActivities,
} from './sweeps';
import { sincronizarPlantillas } from './plantillas-sync';
import { createZavuProvider, enviarPlantilla, getTemplate, listWhatsAppNumbers } from '@iaxti/module-whatsapp';
import { getProvider, registerProvider, simuladorProvider } from '@iaxti/module-channels';
import { canReceiveBusinessInitiated } from '@iaxti/module-crm';
import {
  expireSources,
  tenantsWithExpirable,
  reindexarPendientes,
  embeddingsAvailable,
} from '@iaxti/module-knowledge';
import { automationConsumers, sequenceConsumers, sweepSequences, sweepTimeRules, type EngineDeps } from '@iaxti/module-automations';
import { analyticsConsumers, sweepResponseSamples } from '@iaxti/module-analytics';
import { expireLinks, tenantsWithExpirableLinks } from '@iaxti/module-payments';
import { avisarBorradoPendiente, billingConsumers, sweepBilling } from '@iaxti/module-billing';
import { applyModuleFlags } from '@iaxti/module-platform';
import { flushApiUsage } from './api-usage';
import { deliverWebhooks, webhookConsumers } from '@iaxti/module-integrations';
import { processPaymentWebhook, type PaymentWebhookJob } from './payments';

const service = process.env.SERVICE ?? 'workers';
const port = enteroDeEntorno('PORT', 3000);
let consumersStarted = false;

// Los consumidores reales se registran módulo a módulo en sus issues; el
// despachador y las colas quedan operativos desde ya (issue #13).
function start(): void {
  if (!process.env.DATABASE_URL) {
    console.log('workers: sin DATABASE_URL; outbox y colas esperan configuración');
    return;
  }
  // Los adaptadores de canal, que en este proceso NO estaban registrados
  // (#159). La API los registra desde #41 y los workers nunca: nadie lo
  // notó porque el camino de salida llama a `deliverOutbound` del módulo
  // whatsapp por su nombre, saltándose el puerto entero. O sea que el
  // proceso que de verdad envía mensajes era el que menos usaba la
  // abstracción que nos deja cambiar de proveedor.
  if (!getProvider('simulador')) registerProvider(simuladorProvider);
  for (const kind of ['whatsapp', 'instagram', 'messenger'] as const) {
    if (!getProvider(kind)) registerProvider(createZavuProvider(kind));
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
  const automationDeps: EngineDeps = {
    activeModules: ['conversations', 'crm'].filter((m) => registry.isActive(m)),
  };
  const outboundPublisher = createOutboundPublisher(process.env.REDIS_URL);
  const dispatcher = new OutboxDispatcher(pool, registry, [
    ...outboundRequestConsumers(job => outboundPublisher.enqueue(job), registry),
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
    // ¿El agente logra su objetivo? (#319) Estos cierran el intento cuando
    // el resultado llega por afuera: una PERSONA tomó la hora o mandó el
    // link. Lo que hizo el agente él mismo ya quedó marcado en la
    // transacción de su tool, así que acá no lo vuelve a contar.
    ...objetivoConsumers(),
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
          //
          // Esto estuvo cableado con `disponible: () => false` desde que se
          // escribió: el barrido corría cada vez y no mandaba nada. El
          // motivo era cierto cuando se escribió —hacía falta la plantilla
          // aprobada (#44) y el número conectado— y dejó de serlo sin que
          // nadie volviera a mirar.
          case 'calendar.reminders': {
            const res = await barrerRecordatorios(pool, {
              // Del AMBIENTE: sin llave del proveedor no sale nada de nada.
              disponible: () => Boolean(process.env.ZAVU_API_KEY),
              // Del NEGOCIO: la plantilla del recordatorio es suya. Sin
              // ella, sus citas no se tocan — marcarlas `reminded` sin
              // mandar nada es peor que no marcarlas, porque `reminded` se
              // lee como "al cliente ya se le avisó".
              disponibleParaTenant: (tenantId) =>
                withTenant(pool, tenantId, async (c) => {
                  const cfg = configuracionDeAvisos(await getTenantSettings(c, tenantId));
                  if (!cfg.activo) return false;
                  // `connectedAt` es lo que dice que el número está: el
                  // registro existe desde que se empieza a conectar.
                  const numeros = await listWhatsAppNumbers(c, tenantId);
                  return numeros.some((n) => n.connectedAt !== null);
                }),
              enviar: (cita) =>
                withTenant(pool, cita.tenantId, async (c) => {
                  const cfg = configuracionDeAvisos(await getTenantSettings(c, cita.tenantId));
                  const templateId = cfg.plantillas[cita.aviso];
                  // Un negocio puede querer solo el de 2 h. No es un fallo.
                  if (!templateId) return { enviado: false, motivo: `sin plantilla para el aviso de ${cita.aviso}` };
                  if (!cita.conversationId) {
                    return { enviado: false, motivo: 'la cita no tiene conversación por dónde avisar' };
                  }
                  const plantilla = await getTemplate(c, cita.tenantId, templateId).catch(() => null);
                  if (!plantilla) return { enviado: false, motivo: 'la plantilla configurada ya no existe' };
                  if (plantilla.status !== 'approved') {
                    return { enviado: false, motivo: `la plantilla está ${plantilla.status}` };
                  }
                  const persona = await c.query(
                    'SELECT name FROM contacts WHERE tenant_id = $1 AND id = $2',
                    [cita.tenantId, cita.contactId],
                  );
                  await enviarPlantilla(
                    c,
                    {
                      tenantId: cita.tenantId,
                      conversationId: cita.conversationId,
                      templateId,
                      valores: valoresDelAviso({
                        nombre: persona.rows[0]?.name ?? null,
                        cuando: cita.startsAt,
                        zona: cfg.zona,
                        variables: plantilla.variables,
                      }),
                      requestId: `recordatorio-${cita.appointmentId}-${cita.aviso}`,
                    },
                    {
                      contactoDe: async () => cita.contactId,
                      puedeIniciar: () =>
                        canReceiveBusinessInitiated(c, cita.tenantId, cita.contactId),
                      crearMensaje: (m) =>
                        sendMessage(c, {
                          tenantId: m.tenantId,
                          conversationId: m.conversationId,
                          authorKind: 'system',
                          type: 'texto',
                          body: m.body,
                          // `business`: la cola le aplica el horario de
                          // silencio y la ventana. Acá no se repite.
                          delivery: 'business',
                          requestId: m.requestId,
                        }),
                    },
                  );
                  return { enviado: true };
                }).catch((error: Error) => ({ enviado: false, motivo: error.message })),
            });
            if (res.enviados + res.saltados + res.sinConfigurar > 0) {
              console.log(
                `scheduled: recordatorios ${res.enviados} enviados, ${res.saltados} sin salir, ` +
                  `${res.sinConfigurar} de negocios sin recordatorio configurado`,
              );
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
            // El final del ciclo (#218): el sistema avisa, una persona
            // borra. Nunca se borra solo — es irreversible y se lleva datos
            // de los clientes de nuestro cliente.
            const cola = await avisarBorradoPendiente(pool);
            if (cola.avisados > 0 || cola.enCola > 0) {
              console.log(
                `scheduled: borrado — ${cola.avisados} avisados, ${cola.enCola} esperando decisión del SuperAdmin`,
              );
            }
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
          // Reindexación del conocimiento (#502): al cambiar de modelo de
          // embeddings los vectores viejos no sirven, y las fuentes quedan en
          // 'processing'. Esto es lo que las vuelve a dejar contestando.
          case 'knowledge.reindex': {
            if (!embeddingsAvailable()) {
              // Sin llave no hay nada que reintentar y las fuentes se quedan
              // en 'processing', que es la verdad. Lo decimos una vez por
              // pasada en vez de llenar el log de intentos.
              console.log('scheduled: reindexación en espera — falta GLM_API_KEY');
              return { skipped: true };
            }
            // Los negocios salen de `tenants`, que no filtra por tenant; lo
            // que toca `sources` corre adentro de withTenant. Barrerlos todos
            // de una consulta suelta funcionaría hoy sólo porque el rol es
            // superusuario, y se quedaría en cero el día que deje de serlo
            // (#370). Mismo patrón que el barrido de vigencias.
            const negocios = await tenantsWithExpirable(pool);
            let listas = 0;
            let fallidas = 0;
            let quedanMas = false;
            for (const tenantId of negocios) {
              const r = await withTenant(pool, tenantId, (c) => reindexarPendientes(c, tenantId));
              listas += r.listas;
              fallidas += r.fallidas;
              quedanMas = quedanMas || r.quedanMas;
            }
            if (listas + fallidas > 0) {
              console.log(
                `scheduled: reindexación — ${listas} fuentes listas, ${fallidas} fallidas${quedanMas ? ', quedan más' : ''}`,
              );
            }
            return { listas, fallidas, quedanMas };
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
      // Cada cinco minutos (#502). Va seguido porque mientras haya fuentes
      // sin indexar el negocio tiene la IA sin conocimiento; y no más
      // seguido porque el barrido pasa por todos los negocios y cada fuente
      // reindexada le paga al proveedor.
      scheduled.add(
        'knowledge.reindex',
        { moduleId: 'knowledge' },
        { repeat: { every: 300_000 } },
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
          return processPaymentWebhook(pool, job.data as unknown as PaymentWebhookJob);
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

    // La cola `agents` (#48/#49) la consume el PROCESO de agents (#443).
    // Acá solo se PRODUCE, desde el camino de entrada: una generación tarda
    // segundos y una transcripción más, y mientras tanto este proceso es el
    // que recibe webhooks, despacha salientes y corre los barridos. El
    // despliegue ya tenía su contenedor esperando desde el primer día.

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
      { disabled: 'delay' },
    );
    console.log('workers: worker de cola outbound activo');
  } else {
    console.log('workers: sin REDIS_URL; colas BullMQ esperan configuración');
  }
  consumersStarted = true;
}

// /health comprueba el proceso. /ready exige arranque, Redis y la base del outbox.
const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service }));
    return;
  }
  if (req.url === '/ready') {
    void consumerReadiness('workers', process.env, 2_000, consumersStarted).then(result => {
      res.writeHead(result.statusCode, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(result.body));
    });
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ code: 'NOT_FOUND', message: 'Nada por aquí todavía.', requestId: '', details: [] }));
});

server.listen(port, () => start());
