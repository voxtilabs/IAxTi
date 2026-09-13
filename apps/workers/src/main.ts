import { createServer } from 'node:http';
import { createPool } from '@iaxti/db';
import {
  ModuleRegistry,
  OutboxDispatcher,
  createModuleWorker,
  redisConnection,
} from '@iaxti/core';

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

  const dispatcher = new OutboxDispatcher(pool, registry, []);
  dispatcher.start(500);
  console.log('workers: despachador de outbox activo (500 ms)');

  if (process.env.REDIS_URL) {
    createModuleWorker(
      'scheduled',
      registry,
      async (job) => {
        console.log(`scheduled: job ${job.name} procesado`);
        return { ok: true };
      },
      redisConnection(),
    );
    console.log('workers: worker de cola scheduled activo');
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
