import './instrument';
import { createServer } from 'node:http';
import {
  ModuleRegistry,
  consumerReadiness,
  createModuleWorker,
  enteroDeEntorno,
  entornoDesplegado,
  redisConnection,
  textoDeEntorno,
  versionDelBuild,
} from '@iaxti/core';
import { createPool, exigeRolQueRespetaRls } from '@iaxti/db';
import { alApagar, instalarApagadoOrdenado, plazoDeApagado } from '@iaxti/telemetry';
import { processSuggest, type SuggestJob } from './copilot';
import { candadoEnRedis, deAUnoPorConversacion } from './de-a-uno-por-conversacion';
import { processPulso, type PulsoJob } from './pulso';

const service = textoDeEntorno('SERVICE', 'agents');
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
  // `process.env.IAXTI_ENV` pelado (#575): con la variable declarada sin
  // valor llegaba `''`, que no es `'production'`, y la comprobación de que
  // el rol de la base respeta RLS se degradaba a «grita y sigue» en el
  // ambiente donde justamente no puede.
  void exigeRolQueRespetaRls(pool, entornoDesplegado());

  if (!process.env.REDIS_URL) {
    console.log('agents: sin REDIS_URL; la cola espera configuración');
    return;
  }
  /**
   * En paralelo, pero de a uno por conversación (#1214).
   *
   * Por esta cola pasan TODAS las respuestas de la IA y corría de a un job
   * —el valor por defecto de BullMQ—, así que diez personas escribiendo juntas
   * dejaban a la última esperando un minuto: medido, 15,3 s con la cola vacía
   * contra 82 s con jobs adelante.
   */
  const redisCandado = redisConnection();
  const agentsWorker = createModuleWorker(
    'agents',
    registry,
    // El candado envuelve a LOS DOS trabajos, y eso es lo que importa de esta
    // combinación: un pulso y una respuesta sobre la misma conversación no
    // pueden generarse en paralelo, o la persona recibe dos mensajes que no
    // se conocen. El despacho por nombre va adentro (#1210): `suggest`
    // contesta un mensaje, `pulso` no contesta nada —lo empieza el negocio— y
    // mirar el payload para adivinar cuál es convertiría un campo que falta
    // por un defecto en un mensaje saliente.
    deAUnoPorConversacion(candadoEnRedis(redisCandado), async (job) =>
      job.name === 'pulso'
        ? processPulso(pool, job.data as unknown as PulsoJob, { registry })
        : processSuggest(pool, job.data as unknown as SuggestJob, { registry }),
    ),
    redisConnection(),
  );
  agentsWorker.concurrency = enteroDeEntorno('AGENTS_CONCURRENCY', 5);

  /**
   * El apagado ordenado (#1216).
   *
   * `apps/workers` lo tiene desde siempre y este proceso —el que de verdad
   * genera— nunca lo tuvo: cada despliegue lo mataba con SIGKILL a mitad de
   * una generación.
   *
   * Lo que eso costaba, en orden de gravedad:
   *
   * 1. **Un mensaje repetido.** BullMQ es at-least-once y el job vuelve a
   *    tomarse al vencer su lock. Si el proceso muere DESPUÉS de entregar la
   *    respuesta y antes de que el job termine, el reintento la genera y la
   *    entrega otra vez: el cliente recibe dos. El apagado ordenado no lo
   *    vuelve imposible —una caída real sigue pudiendo— pero cierra la única
   *    ventana que abríamos nosotros a propósito, varias veces por día. Lo que
   *    sí lo vuelve imposible es idempotencia en el camino, y eso va aparte.
   * 2. **Media conversación de espera.** El job cortado no se pierde: se
   *    reintenta cuando vence el lock (30 s por omisión de BullMQ) y además
   *    necesita que el proceso nuevo ya esté arriba para marcarlo colgado. Son
   *    30 s y pico de silencio para alguien que acaba de escribir.
   * 3. **La generación pagada se tira.** Los tokens ya se gastaron.
   *
   * El orden: primero se drena el worker —`close()` deja de TOMAR trabajo y
   * espera al que está en vuelo—, después la base, que el worker usa mientras
   * drena. El servidor de sondas se cierra al final, en `listen`, para que
   * `/health` siga contestando mientras se drena y el orquestador no lo mate
   * antes de tiempo.
   */
  alApagar('worker de cola agents', () => agentsWorker.close());
  alApagar('candado de conversaciones', () => redisCandado.quit().then(() => undefined));
  alApagar('base de datos', () => pool.end());

  consumersStarted = true;
  const plazo = plazoDeApagado();
  console.log(`agents: worker de cola agents activo (plazo de apagado ${plazo} ms)`);
  /**
   * Una generación tarda más que el plazo, y decirlo es el punto.
   *
   * Medido hoy: 7,4 s de modelo y ~20 s de punta a punta con la espera de
   * #1223. El plazo por omisión son 8 s porque Docker manda SIGKILL a los 10,
   * así que un drenaje que no alcanza NO es un defecto de este código: es el
   * `stop_grace_period` del despliegue, que hay que subir junto con
   * `SHUTDOWN_TIMEOUT_MS`. Subir solo la variable es prometer lo que el
   * orquestador no deja cumplir, y por eso el aviso nombra las dos.
   */
  if (plazo < 25_000) {
    console.warn(
      `agents: con ${plazo} ms no alcanza a terminar una generación (tardan ~20 s). ` +
        'Sube SHUTDOWN_TIMEOUT_MS y el stop_grace_period del compose a la vez, o el ' +
        'SIGKILL llegará igual y el job se reintentará.',
    );
  }
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

instalarApagadoOrdenado();

server.listen(port, () => {
  start();
  // Al final de la lista: mientras se drena, `/health` sigue contestando.
  // `closeAllConnections` porque una sonda con keep-alive abierto dejaría
  // `close()` esperando para siempre.
  alApagar('servidor de sondas', () =>
    new Promise<void>((listo) => {
      server.closeAllConnections();
      server.close(() => listo());
    }),
  );
});
