import { readFileSync, writeFileSync } from 'node:fs';

// El documento se obtiene de /docs-json de la API. No se adivinan rutas.
const document = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const operaciones = [
  'CampanasController_listar', 'CampanasController_crear', 'CampanasController_previa',
  'CampanasController_enviar', 'CampanasController_resultados', 'CampanasController_segmentos',
  'PlantillasController_list', 'ChannelsController_list', 'TagsController_list',
  'MeController_accesoDeModulos',
];
const routes = {};
for (const id of operaciones) {
  for (const [path, methods] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (operation.operationId === id) routes[id] = { method: method.toUpperCase(), path };
    }
  }
  if (!routes[id]) throw new Error(`Falta la operación ${id} en OpenAPI.`);
}
writeFileSync(new URL('../src/campaign-routes.generated.ts', import.meta.url),
  '// Generado desde OpenAPI por scripts/generate-campaigns.mjs. No editar a mano.\n' +
  `export const campaignRoutes = ${JSON.stringify(routes, null, 2)} as const;\n`);
