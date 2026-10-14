#!/usr/bin/env node
// Guarda de #588, punto 4: «nada silencioso».
//
// Falla si un `fetch` de las pantallas manda algo y NUNCA mira qué contestó.
// No es un detalle de estilo: `fetch` no tira error con un 4xx ni con un 5xx,
// así que el código que no pregunta por la respuesta sigue de largo como si
// hubiera salido bien. En el panel de plataforma eso hacía que el tope de API
// y la retención del tenant VOLVIERAN al valor anterior sin un solo mensaje:
// se lee como una pantalla rota, no como un pedido rechazado.
//
// ## Por qué esto es una guarda y no una lista
//
// La issue nombraba tres pantallas mudas. Cuando llegué, DOS ya estaban
// arregladas por otro camino —el `catch` de #560 y el de `accion`— y las dos
// que de verdad estaban mudas ese día (la retención y la baja de push) no
// figuraban. Una lista escrita a mano envejece en las dos direcciones a la
// vez: acusa lo que ya se arregló y calla lo que apareció después. El patrón,
// en cambio, se puede preguntar al código.
//
// ## La otra puerta: `void apiFetch(...)`
//
// La primera versión de esta guarda solo miraba el `fetch` pelado, y se le
// pasaban tres sitios que fallan igual de callados por el otro camino.
// `apiFetch` LANZA con un 4xx o un 5xx —de eso se encarga él— así que el
// problema ahí no es mirar la respuesta sino atrapar el rechazo: un
// `void apiFetch(...).then(recargar)` sin `catch` deja una promesa rechazada
// sin dueño, la recarga no corre, y la pantalla se queda exactamente como
// estaba. Eso no se lee como «no se pudo»: se lee como que el botón no hace
// nada. El único mensaje queda en la consola del navegador.
//
// Se marca solo la forma `void`, que es la que declara «esto no se espera».
// Un `await apiFetch(...)` dentro de un `try` ya está cubierto por el
// lenguaje, y exigirle un `.catch` además sería pedir dos redes para el mismo
// pez.
//
// ## Qué cuenta como «mirar»
//
// Cualquier uso de la respuesta: `.ok`, `.status`, `.json()`, `.text()`, o un
// `.then(...)` encadenado. Alcanza con que la consulte: si alguien lee `.ok`
// y decide ignorarlo, eso es una decisión escrita y revisable, que es todo lo
// que una guarda puede exigir. Lo que no se puede dejar pasar es la respuesta
// que nadie abrió.
//
// Un `return fetch(...)` no se marca: el que recibe la promesa es quien tiene
// que mirarla, y marcarlo acá sería pedirle dos veces lo mismo.
// Probada mordiendo antes de colgarla: con el `await fetch(...)` original de
// `TopePropio` copiado a un archivo suelto falla y lo nombra; con el `res.ok`
// puesto, calla. Una guarda que no se vio fallar no es una guarda, es un
// comentario que se ejecuta.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const RAICES = ['apps/web', 'apps/admin', 'packages/ui/src'];
const VENTANA = 16;

function archivos(dir) {
  const salida = [];
  for (const entrada of readdirSync(dir)) {
    if (entrada === 'node_modules' || entrada === '.next' || entrada === 'dist') continue;
    const ruta = join(dir, entrada);
    if (statSync(ruta).isDirectory()) salida.push(...archivos(ruta));
    else if (/\.tsx?$/.test(entrada)) salida.push(ruta);
  }
  return salida;
}

const hallazgos = [];
for (const raiz of RAICES) {
  for (const ruta of archivos(raiz)) {
    const lineas = readFileSync(ruta, 'utf8').split('\n');
    for (let i = 0; i < lineas.length; i += 1) {
      const linea = lineas[i];
      if (!/\bfetch\(/.test(linea)) continue;
      // Los comentarios NOMBRAN el patrón —esta guarda nació junto a tres
      // comentarios que cuentan el arreglo citando `await fetch(...)`—, y una
      // guarda que se dispara con su propia explicación es una guarda que se
      // aprende a ignorar.
      if (/^\s*(\/\/|\*|\/\*)/.test(linea)) continue;
      // El que devuelve la promesa delega la revisión en quien la recibe.
      if (/\breturn\s+(await\s+)?([A-Za-z_$][\w$.]*\.)?fetch\(/.test(linea)) continue;

      const ventana = lineas.slice(i, i + VENTANA).join('\n');
      // Encadenado: `fetch(...).then(...)`, aunque el `.then` caiga en la
      // línea de abajo. Pedirlo en la misma línea marcaría como mudo un
      // `fetch` que sí revisa, solo por cómo lo partió el formateador.
      if (/\.then\(/.test(ventana)) continue;

      // El receptor es opcional: `route.fetch(...)` de Playwright devuelve una
      // respuesta igual que el `fetch` global, y pedirla pelada dejaba fuera
      // justo al que sí la revisaba.
      const asignado = linea.match(
        /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:[A-Za-z_$][\w$.]*\.)?fetch\(/,
      );
      if (asignado) {
        const nombre = asignado[1];
        const consulta = new RegExp(`\\b${nombre}\\.(ok|status|json|text|headers|body)\\b`);
        if (consulta.test(ventana)) continue;
        hallazgos.push(`${ruta}:${i + 1} — guarda la respuesta en \`${nombre}\` y nunca la abre`);
        continue;
      }
      hallazgos.push(`${ruta}:${i + 1} — tira el pedido y descarta la respuesta`);
    }

    // Y la segunda puerta, en la misma pasada por el archivo.
    for (let i = 0; i < lineas.length; i += 1) {
      if (!/\bvoid\s+apiFetch\(/.test(lineas[i])) continue;
      if (/^\s*(\/\/|\*|\/\*)/.test(lineas[i])) continue;
      const ventana = lineas.slice(i, i + VENTANA).join('\n');
      if (/\.catch\(/.test(ventana)) continue;
      hallazgos.push(`${ruta}:${i + 1} — \`void apiFetch\` sin \`.catch\`: el rechazo queda sin dueño`);
    }
  }
}

if (hallazgos.length > 0) {
  console.error('fetch que no mira qué contestó el servidor (#588, punto 4):\n');
  for (const h of hallazgos) console.error(`  ${h}`);
  console.error(
    '\nCon `fetch`, un 4xx o un 5xx no tira error: sin mirar `res.ok` el código\n' +
      'sigue como si hubiera salido bien. Con `apiFetch` sí tira, y sin `.catch`\n' +
      'el rechazo queda sin dueño. En los dos casos el servidor rechazó y la\n' +
      'pantalla no lo dice: se lee como una interfaz rota y no como un pedido\n' +
      'denegado.\n' +
      'Mirá la respuesta y mostrá el mensaje, o atrapá el rechazo. Si el fallo\n' +
      'de verdad no se puede mostrar —la pantalla se va con el clic—, un\n' +
      '`.catch(() => {})` con el motivo escrito arriba es una decisión; la\n' +
      'ausencia no.',
  );
  process.exit(1);
}
console.log('respuestas-sin-mirar: ninguna');
