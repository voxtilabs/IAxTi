#!/usr/bin/env node
// Las rutas que usa `packages/sdk/src/campaigns.ts`, sacadas del OpenAPI.
//
// ## Por qué existe este archivo
//
// `campaign-routes.generated.ts` decía en su primera línea «Generado desde
// OpenAPI por scripts/generate-campaigns.mjs. No editar a mano», y en esa ruta
// no había nada. Apareció al agregar `detener` y `seguir` (#609, #610): dos
// rutas nuevas que el SDK necesita y que no había manera legítima de meter.
//
// **Corrección (#832).** Cuando escribí esto dije que el script «no existía»,
// y era falso: existía en `packages/sdk/scripts/generate-campaigns.mjs`, desde
// #357. Busqué la ruta que el encabezado nombraba, no la encontré, y concluí
// que no había ninguno. Lo que de verdad pasaba es peor y más específico: el
// encabezado del archivo generado apuntaba a un camino que no existía mientras
// un script con el mismo nombre de archivo vivía en otra carpeta.
//
// Y durante un día hubo DOS, con salidas distintas. El viejo tenía doce
// operaciones y le faltaban justo `detener` y `seguir`, así que correrlo
// borraba del SDK el botón Detener y el Seguir de una campaña a medias — y el
// README mandaba a correr ese. El typecheck lo caza, pero el rojo aparece en
// `campaigns.ts` nombrando la operación, no el generador, y el arreglo que
// sugiere es borrar `stop`/`resume` del cliente: justo la regresión.
//
// El viejo se borró y el README apunta acá.
//
// ## Qué hace
//
// Recorre el OpenAPI y se queda con las operaciones que el cliente de campañas
// nombra. La LISTA está acá y es a propósito: el SDK de campañas es chico y
// deliberado, no «todo lo que exponga la API». Si falta una, el script falla
// con su nombre en vez de generar un archivo al que le falte una ruta — un
// `undefined` en `campaignRoutes[op]` revienta recién en la pantalla.
//
// Uso: node scripts/generate-campaigns.mjs /tmp/iaxti-openapi.json
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** La raíz del repo, deducida de ESTE archivo y no del directorio actual. */
export const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');

export const DESTINO = 'packages/sdk/src/campaign-routes.generated.ts';

/**
 * El texto del archivo, aparte, para que una guarda pueda regenerarlo en
 * memoria y compararlo con el disco (#832). Es el mismo patrón que el catálogo
 * de herramientas del Agente General: un archivo generado sin una prueba que
 * lo reproduzca se queda viejo desde el commit siguiente, y la cabecera que
 * dice «no editar a mano» no lo impide.
 */
export function textoDelArchivo(rutas) {
  return (
    `// Generado desde OpenAPI por scripts/generate-campaigns.mjs. No editar a mano.\n` +
    `export const campaignRoutes = ${JSON.stringify(rutas, null, 2)} as const;\n`
  );
}

export const OPERACIONES = [
  'CampanasController_listar',
  'CampanasController_crear',
  'CampanasController_previa',
  'CampanasController_enviar',
  'CampanasController_detener',
  'CampanasController_seguir',
  'CampanasController_resultados',
  'CampanasController_segmentos',
  'CampanasController_vistaPrevia',
  'CampanasController_guardar',
  'PlantillasController_list',
  'ChannelsController_list',
  'TagsController_list',
  'MeController_accesoDeModulos',
];

/** Las rutas de las operaciones que el SDK nombra, desde un OpenAPI ya leído. */
export function rutasDesdeOpenapi(openapi) {
  const porOperacion = new Map();
  for (const [path, metodos] of Object.entries(openapi.paths ?? {})) {
    for (const [method, op] of Object.entries(metodos)) {
      if (op?.operationId) porOperacion.set(op.operationId, { method: method.toUpperCase(), path });
    }
  }
  const faltan = OPERACIONES.filter((o) => !porOperacion.has(o));
  if (faltan.length > 0) {
    throw new Error(
      `No están en el OpenAPI: ${faltan.join(', ')}. Si una ruta se renombró, cámbiala en la ` +
        'lista de este script.',
    );
  }
  const salida = {};
  for (const op of OPERACIONES) salida[op] = porOperacion.get(op);
  return salida;
}

/**
 * El trabajo solo cuando se CORRE, no al importarlo.
 *
 * La guarda de #832 importa este archivo para regenerar en memoria y comparar
 * con el disco. Sin este `if`, importarlo leería `process.argv[2]`, buscaría un
 * OpenAPI que no está y mataría el proceso de las pruebas con un `process.exit`.
 */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const ruta = process.argv[2] ?? '/tmp/iaxti-openapi.json';
  try {
    const rutas = rutasDesdeOpenapi(JSON.parse(readFileSync(ruta, 'utf8')));
    // Resuelto contra la raíz del repo: escrito como ruta relativa, el script
    // solo funcionaba corriéndolo desde la raíz y desde cualquier otro lado
    // dejaba el archivo en un lugar nuevo sin avisar.
    writeFileSync(join(RAIZ, DESTINO), textoDelArchivo(rutas));
    console.log(`rutas del SDK de campañas: ${OPERACIONES.length}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
