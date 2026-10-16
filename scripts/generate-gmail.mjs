import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const GMAIL_OPERATIONS = ['GmailController_estado', 'GmailController_iniciar', 'GmailController_completar', 'GmailController_revocar', 'GmailController_get_threads'];
export function gmailRoutes(document) {
  return Object.fromEntries(GMAIL_OPERATIONS.map((name) => {
    for (const [path, methods] of Object.entries(document.paths ?? {})) {
      for (const [method, op] of Object.entries(methods)) {
        if (op?.operationId === name) return [name, { method: method.toUpperCase(), path }];
      }
    }
    throw new Error(`Falta la operación OpenAPI ${name}`);
  }));
}
export function gmailRoutesSource(document) {
  return '// Generado desde OpenAPI por scripts/generate-gmail.mjs. No editar a mano.\n'
    + `export const gmailRoutes = ${JSON.stringify(gmailRoutes(document), null, 2)} as const;\n`;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const source = gmailRoutesSource(JSON.parse(readFileSync(process.argv[2], 'utf8')));
  writeFileSync(join(root, 'packages/sdk/src/gmail-routes.generated.ts'), source);
}
