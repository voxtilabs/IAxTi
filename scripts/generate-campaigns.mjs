#!/usr/bin/env node
// Las rutas que usa `packages/sdk/src/campaigns.ts`, sacadas del OpenAPI.
//
// ## Por qué existe este archivo
//
// `campaign-routes.generated.ts` decía en su primera línea «Generado desde
// OpenAPI por scripts/generate-campaigns.mjs. No editar a mano» — y ese script
// **no existía**. O sea que la única forma correcta de actualizarlo era
// imposible, y la única forma posible estaba prohibida por su propio
// encabezado. Es el defecto de siempre del repo —declarado en un lado,
// aplicado en ninguno— con el agravante de que la nota desalentaba el único
// arreglo disponible.
//
// Apareció al agregar `detener` y `seguir` (#609, #610): dos rutas nuevas que
// el SDK necesita y que no había manera legítima de meter.
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

const OPERACIONES = [
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

const ruta = process.argv[2] ?? '/tmp/iaxti-openapi.json';
const openapi = JSON.parse(readFileSync(ruta, 'utf8'));

const porOperacion = new Map();
for (const [path, metodos] of Object.entries(openapi.paths ?? {})) {
  for (const [method, op] of Object.entries(metodos)) {
    if (op?.operationId) porOperacion.set(op.operationId, { method: method.toUpperCase(), path });
  }
}

const faltan = OPERACIONES.filter((o) => !porOperacion.has(o));
if (faltan.length > 0) {
  console.error('No están en el OpenAPI:', faltan.join(', '));
  console.error('Si una ruta se renombró, cámbiala en la lista de este script.');
  process.exit(1);
}

const salida = {};
for (const op of OPERACIONES) salida[op] = porOperacion.get(op);

writeFileSync(
  'packages/sdk/src/campaign-routes.generated.ts',
  `// Generado desde OpenAPI por scripts/generate-campaigns.mjs. No editar a mano.\n` +
    `export const campaignRoutes = ${JSON.stringify(salida, null, 2)} as const;\n`,
);
console.log(`rutas del SDK de campañas: ${OPERACIONES.length}`);
