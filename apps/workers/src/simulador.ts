// Simulador de mensajes entrantes (#36): encola en la MISMA cola `inbound`
// que usará el canal real, así la Fase 2 prueba estados, reapertura y SLA
// sin WhatsApp. Solo local y staging: en producción no existe.
//
// Uso (dentro del contenedor de workers o con REDIS_URL exportado):
//   node dist/simulador.js --tenant <uuid> --phone "+56 9 1234 5678" \
//     --body "Hola, ¿precios?" [--channel simulador] [--type texto] \
//     [--provider-id wamid.test1]
import { createQueue, esProduccion, redisConnection } from '@iaxti/core';
import type { InboundJob } from './inbound';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  // Con `(process.env.IAXTI_ENV ?? 'dev') === 'production'` esta guarda no
  // se disparaba si la variable estaba declarada sin valor (#575): `''` no es
  // `'production'`, así que el simulador encolaba mensajes inventados en la
  // cola `inbound` REAL, en el tenant real, y aparecían en la bandeja como si
  // un cliente hubiera escrito.
  if (esProduccion()) {
    console.error('El simulador no existe en producción.');
    process.exit(1);
  }
  const tenantId = arg('tenant');
  const phone = arg('phone');
  if (!tenantId || !phone) {
    console.error('Faltan --tenant y --phone. Ej: --tenant <uuid> --phone "+56912345678" --body "hola"');
    process.exit(1);
  }
  const job: InboundJob = {
    moduleId: 'conversations',
    tenantId,
    phone,
    channel: (arg('channel') as InboundJob['channel']) ?? 'simulador',
    type: (arg('type') as InboundJob['type']) ?? 'texto',
    body: arg('body'),
    providerMessageId: arg('provider-id'),
    requestId: `sim-${Date.now()}`,
  };
  const connection = redisConnection();
  const queue = createQueue('inbound', connection);
  const added = await queue.add('simulado', job);
  console.log(`simulador: mensaje encolado (job ${added.id}) para el tenant ${tenantId}`);
  await queue.close();
  connection.disconnect();
}

main().catch((err) => {
  console.error('simulador: no se pudo encolar —', err.message);
  process.exit(1);
});
