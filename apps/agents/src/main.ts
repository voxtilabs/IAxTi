import './instrument';
import { createServer } from 'node:http';
import {
  ModuleRegistry,
  consumerReadiness,
  createModuleWorker,
  enteroDeEntorno,
  redisConnection,
  versionDelBuild,
} from '@iaxti/core';
import { createPool, exigeRolQueRespetaRls } from '@iaxti/db';
import { processSuggest, type SuggestJob } from './copilot';

const service = process.env.SERVICE ?? 'agents';
const port = enteroDeEntorno('PORT', 3000);
let consumersStarted = false;

/**
 * El proceso de los agentes (#443).
 *
 * Existía en el despliegue desde el primer día contestando solo `/health`:
 * «stub de fundación, el procesamiento real llega con el #47» — y el #47 se
 * cerró hace rato. El trabajo de IA corría dentro de workers, en la misma
 * cola de eventos que el camino de entrada y de salida de mensajes.
 *
 * Separarlo no es prolijidad: una generación tarda segundos y una
 * transcripción de audio más, y mientras tanto ese proceso es el que recibe
 * los webhooks encolados, despacha los salientes y corre los barridos. La
 * separación que el despliegue insinuaba no existía.
 *
 * Lo que NO se movió: quien ENCOLA sigue siendo el camino de entrada, en
 * workers. Acá solo se consume.
 */
function start(): void {
  if (!process.env.DATABASE_URL) {
    console.log('agents: sin DATABASE_URL; la cola espera configuración');
    return;
  }
  const registry = new ModuleRegistry().load();
  const pool = createPool();
  // Igual que la API y los workers (#211): un rol que se salta RLS no sirve.
  // Grita y sigue; en producción la API además se niega a servir (#227).
  void exigeRolQueRespetaRls(pool, process.env.IAXTI_ENV);

  if (!process.env.REDIS_URL) {
    console.log('agents: sin REDIS_URL; la cola espera configuración');
    return;
  }
  createModuleWorker(
    'agents',
    registry,
    async (job) => processSuggest(pool, job.data as unknown as SuggestJob, { registry }),
    redisConnection(),
  );
  consumersStarted = true;
  console.log('agents: worker de cola agents activo');
}

// `/health` es "el proceso vive" y `/ready` es "puede trabajar", que para un
// consumidor de colas significa Redis, la base y haber arrancado (#17).
const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    // La versión, igual que en la API (#565): un despliegue que dice
    // «done» sobre la imagen anterior es lo que hoy no se vería.
    res.end(JSON.stringify({ status: 'ok', service, ...versionDelBuild() }));
    return;
  }
  if (req.url === '/ready') {
    void consumerReadiness('agents', process.env, 2_000, consumersStarted).then((result) => {
      res.writeHead(result.statusCode, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(result.body));
    });
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ code: 'NOT_FOUND', message: 'Nada por aquí todavía.', requestId: '', details: [] }));
});

server.listen(port, () => start());
