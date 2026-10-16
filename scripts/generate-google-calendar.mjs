import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const GOOGLE_OPERATIONS = ['GoogleCalendarController_estado', 'GoogleCalendarController_iniciar', 'GoogleCalendarController_completar', 'GoogleCalendarController_revocar'];
export function googleRoutes(document) {
  return Object.fromEntries(GOOGLE_OPERATIONS.map((name) => {
    for (const [path, methods] of Object.entries(document.paths ?? {})) {
      for (const [method, op] of Object.entries(methods)) {
        if (op?.operationId === name) return [name, { method: method.toUpperCase(), path }];
      }
    }
    throw new Error(`Falta la operación OpenAPI ${name}`);
  }));
}
export function googleRoutesSource(document) {
  return '// Generado desde OpenAPI por scripts/generate-google-calendar.mjs. No editar a mano.\n'
    + `export const googleCalendarRoutes = ${JSON.stringify(googleRoutes(document), null, 2)} as const;\n`;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const source = googleRoutesSource(JSON.parse(readFileSync(process.argv[2], 'utf8')));
  writeFileSync(join(root, 'packages/sdk/src/google-calendar-routes.generated.ts'), source);
}
