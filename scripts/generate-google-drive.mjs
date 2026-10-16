import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DRIVE_OPERATIONS = ['DriveController_estado', 'DriveController_iniciar', 'DriveController_completar', 'DriveController_revocar', 'DriveController_selector', 'DriveController_seleccionar', 'DriveController_permisoIa', 'DriveController_adjuntos', 'DriveController_carpeta', 'DriveController_estadoCarpeta', 'DriveController_search', 'DriveController_attach'];
export function driveRoutes(document) {
  return Object.fromEntries(DRIVE_OPERATIONS.map((name) => {
    for (const [path, methods] of Object.entries(document.paths ?? {})) {
      for (const [method, op] of Object.entries(methods)) {
        if (op?.operationId === name) return [name, { method: method.toUpperCase(), path }];
      }
    }
    throw new Error(`Falta la operación OpenAPI ${name}`);
  }));
}
export function driveRoutesSource(document) {
  return '// Generado desde OpenAPI por scripts/generate-google-drive.mjs. No editar a mano.\n'
    + `export const googleDriveRoutes = ${JSON.stringify(driveRoutes(document), null, 2)} as const;\n`;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const source = driveRoutesSource(JSON.parse(readFileSync(process.argv[2], 'utf8')));
  writeFileSync(join(root, 'packages/sdk/src/google-drive-routes.generated.ts'), source);
}
