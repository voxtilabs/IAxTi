import { readFileSync, writeFileSync } from 'node:fs';
const document = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const wanted = ['ContactsController_list', 'DealsController_list', 'TagsController_list', 'TagsController_agregarEnLote'];
const routes = {};
for (const id of wanted) {
  for (const [path, methods] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (operation.operationId === id) routes[id] = { method: method.toUpperCase(), path };
    }
  }
  if (!routes[id]) throw new Error(`Falta ${id} en OpenAPI`);
}
writeFileSync(new URL('../src/crm-routes.generated.ts', import.meta.url), '// Generado desde OpenAPI por scripts/generate-crm.mjs. No editar a mano.\nexport const crmRoutes = ' + JSON.stringify(routes, null, 2) + ' as const;\n');
