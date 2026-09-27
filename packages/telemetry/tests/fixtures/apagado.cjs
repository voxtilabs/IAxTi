// Un proceso con un job en vuelo al que le llega SIGTERM.
//
// Es el despliegue, en chico: hay trabajo a medio hacer, llega la señal, y lo
// que importa es si el trabajo alcanzó a TERMINAR antes de que el proceso se
// fuera. Sin apagado ordenado nadie toma la señal y el job muere a la mitad,
// que es justo lo que hace que BullMQ lo reintente y el WhatsApp salga dos
// veces.
//
// Las dos funciones se leen con `?.` a propósito: así este fixture también
// corre contra una versión de telemetría que no las tenga, y el rojo que se ve
// entonces es el del DEFECTO —el job no terminó— y no un TypeError.
const telemetry = require('../../dist');

telemetry.initObservability('apagado-test');
telemetry.instalarApagadoOrdenado?.();

const pasos = [];
let jobTerminado = false;
const alApagar = telemetry.alApagar ?? (() => {});

// El orden importa: primero se deja de producir, después se drena, y al final
// se cierra aquello de lo que los dos dependen.
alApagar('productor', () => {
  pasos.push('productor');
});
alApagar('cola con un job en vuelo', async () => {
  await new Promise((listo) => setTimeout(listo, 150));
  jobTerminado = true;
  pasos.push('cola');
});
// Uno que se rompe al cerrar: no debe impedir que cierren los que siguen.
alApagar('el que se rompe al cerrar', () => {
  throw new Error('no cerré');
});
alApagar('base de datos', () => {
  pasos.push('base');
});

let nadieTomoLaSenal = false;

process.on('exit', (codigo) => {
  process.stdout.write(
    JSON.stringify({
      jobTerminado,
      pasos,
      codigo,
      nadieTomoLaSenal,
      enCurso: telemetry.apagadoEnCurso?.() ?? null,
    }) + '\n',
  );
});

// Señal DE VERDAD, no `process.emit('SIGTERM')`.
//
// `emit` llama a los listeners directamente y se salta la máquina de señales:
// pasa aunque el manejador se registre tarde, aunque libuv no lo haya
// enganchado, aunque en el proceso real la acción por omisión mate el proceso
// antes de que alguien lo escuche. O sea: probaba que la función existe, no que
// el apagado ordenado ocurre. `process.kill` sobre el propio pid entrega la
// señal por el sistema operativo, que es lo que hace Docker al desplegar.
process.kill(process.pid, 'SIGTERM');

// Si nadie tomó la señal, el proceso se queda acá hasta este plazo. Sale con 0
// igual para que la prueba pueda contar QUÉ pasó —el job no terminó, los pasos
// están vacíos— en vez de un "el comando falló" que no dice nada.
setTimeout(() => {
  nadieTomoLaSenal = true;
  process.exit(0);
}, 3_000);
