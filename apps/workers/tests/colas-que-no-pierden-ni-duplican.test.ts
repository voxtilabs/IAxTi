import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * El cableado del apagado y de las colas, mirado en el código.
 *
 * Las tres cosas que esto guarda no se pueden comprobar llamando a una función:
 * son decisiones que viven en el entrypoint, y el entrypoint abre un servidor y
 * se conecta a Redis y a Postgres en cuanto se importa.
 *
 * Y son exactamente las que se rompen sin que nada falle:
 *
 * - Un worker nuevo que nadie registra para drenar. No da error: se queda
 *   corriendo hasta que el SIGTERM lo mata a mitad de job, BullMQ lo reintenta
 *   —es at-least-once— y el WhatsApp sale dos veces. En cada despliegue.
 * - El worker de `outbound` sin el aviso de `failed`. Tampoco da error: el job
 *   se va a `failed` y la fila se queda en `queued` para siempre, o sea
 *   «enviando» en la bandeja del vendedor, sin nadie que vuelva a mirarla.
 * - La concurrencia de `scheduled`. El worker de BullMQ nace con 1, así que los
 *   repetibles «cada minuto» dejan de ser cada minuto en cuanto un barrido
 *   lento los pone en fila india. Nada falla; simplemente llegan tarde.
 *
 * Mismo criterio que `consumidores-registrados.test.ts`: una guarda sobre el
 * cableado, ahí donde el cableado es lo que se olvida.
 */
const MAIN = readFileSync(join(__dirname, '..', 'src', 'main.ts'), 'utf8');

describe('el apagado ordenado está cableado', () => {
  it('el proceso toma las señales', () => {
    expect(MAIN).toContain("import { alApagar, instalarApagadoOrdenado } from '@iaxti/telemetry'");
    expect(MAIN).toContain('instalarApagadoOrdenado();');
  });

  it('cada worker de cola queda registrado para drenar', () => {
    const creados = [...MAIN.matchAll(/const (\w+) = createModuleWorker\(/g)].map((m) => m[1]);
    // Si esto da 0, la guarda dejó de mirar lo que cree mirar.
    expect(creados.length).toBeGreaterThanOrEqual(3);

    // Ninguna llamada tira su worker a la basura: sin la referencia no hay
    // `close()` posible, y sin `close()` el job en vuelo muere con el proceso.
    const llamadas = [...MAIN.matchAll(/createModuleWorker\(/g)].length;
    expect(llamadas, 'Hay un createModuleWorker cuyo worker no se guarda en ninguna variable.').toBe(
      creados.length,
    );

    const sinDrenar = creados.filter((nombre) => !MAIN.includes(`worker: ${nombre} }`));
    expect(
      sinDrenar,
      'Estos workers se crean y NO se registran para drenar en el apagado:\n' +
        sinDrenar.map((n) => `  ${n}`).join('\n') +
        '\nSIGTERM los mata a mitad de job y BullMQ reintenta: el mensaje sale dos veces.',
    ).toEqual([]);

    expect(MAIN).toMatch(/for \(const \{ nombre, worker \} of trabajadores\)[\s\S]{0,120}alApagar/);
  });

  it('también se cierra lo que los workers usan, y en un orden que sirve', () => {
    const registrados = [...MAIN.matchAll(/alApagar\('([^']+)'/g)].map((m) => m[1]);
    expect(registrados).toContain('despachador de outbox');
    expect(registrados).toContain('publicador de salientes');
    expect(registrados).toContain('base de datos');
    expect(registrados).toContain('servidor de sondas');
    // Primero se deja de producir trabajo, y la base se cierra después de los
    // workers: al revés, el drenaje se queda sin con qué escribir.
    expect(registrados.indexOf('despachador de outbox')).toBeLessThan(
      registrados.indexOf('base de datos'),
    );
    expect(MAIN.indexOf("alApagar('base de datos'")).toBeGreaterThan(
      MAIN.indexOf('of trabajadores'),
    );
  });
});

describe('el saliente abandonado y los barridos', () => {
  it('el worker de outbound avisa cuando la cola se da por vencida', () => {
    expect(MAIN).toMatch(/outboundWorker\.on\('failed'/);
    expect(MAIN).toMatch(/cerrarEnvioAbandonado\(pool, job, err\)/);
  });

  // Acá se asegura solo que la cola está EN PARALELO y que pasa por el
  // guardián. Que el guardián SIRVA se prueba en `sin-solaparse.test.ts`,
  // llamándolo dos veces a la vez.
  //
  // La versión anterior de esta prueba aseguraba el texto fuente del guardián
  // entero —`expect(MAIN).toContain('enCurso.has(llave)')` y la línea literal de
  // la llave— y tenía los dos defectos que tiene medir por proxy: pasaba con el
  // cuerpo del `if` vacío, y se ponía roja cuando alguien reformateaba main.ts
  // sin tocar ningún archivo en común. Lo segundo es un generador de conflictos
  // para toda rama futura.
  it('la cola scheduled corre en paralelo y su trabajo pasa por el guardián', () => {
    expect(MAIN).toMatch(
      /scheduledWorker\.concurrency = enteroDeEntorno\('WORKERS_SCHEDULED_CONCURRENCY', [2-9]/,
    );
    // Con concurrencia > 1, BullMQ puede arrancar la pasada siguiente de un
    // repetible antes de que termine la anterior. Dos `calendar.reminders` a la
    // vez mandan el mismo recordatorio dos veces.
    expect(MAIN).toMatch(/sinSolaparse\(correrProgramado, candadoEnRedis\(/);
  });
});
