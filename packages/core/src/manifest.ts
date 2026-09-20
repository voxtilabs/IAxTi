import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

export interface ModuleManifest {
  module: { id: string; version: string; core?: boolean };
  depends_on?: { required?: string[]; optional?: string[] };
  permissions?: string[];
  events?: { publishes?: string[]; consumes?: string[] };
  tools?: string[];
  /**
   * `grupo` reparte la navegación en la barra lateral (#295). Lo declara el
   * módulo y no una tabla en el frontend, igual que el resto del `nav`: con
   * 23 destinos, una lista paralela allá se desincroniza y el destino nuevo
   * aparece suelto abajo sin que nadie lo note.
   */
  nav?: Array<{ label: string; path: string; permission: string; grupo?: string }>;
  widgets?: Array<{ id: string; permission: string }>;
  plan_min?: string;
  flag?: string;
}

/** Busca packages/modules subiendo desde `start`; MODULES_DIR lo fija explícito. */
export function findModulesDir(start = process.cwd()): string {
  if (process.env.MODULES_DIR) return process.env.MODULES_DIR;
  let dir = resolve(start);
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'packages', 'modules');
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`No se encontró packages/modules desde ${start}; define MODULES_DIR`);
}

/** Lee y valida un manifiesto. El id debe coincidir con el nombre del directorio. */
export function loadManifest(modulesDir: string, dirName: string): ModuleManifest {
  const path = join(modulesDir, dirName, 'module.yaml');
  const manifest = parse(readFileSync(path, 'utf8')) as ModuleManifest;

  if (!manifest?.module?.id) throw new Error(`${path}: falta module.id`);
  if (!manifest.module.version) throw new Error(`${path}: falta module.version`);
  if (manifest.module.id !== dirName) {
    throw new Error(
      `${path}: el id "${manifest.module.id}" no coincide con el directorio "${dirName}"`,
    );
  }
  return manifest;
}

/** Carga todos los manifiestos del directorio de módulos. */
export function loadAllManifests(modulesDir: string): ModuleManifest[] {
  const manifests: ModuleManifest[] = [];
  for (const entry of readdirSync(modulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!existsSync(join(modulesDir, entry.name, 'module.yaml'))) continue;
    manifests.push(loadManifest(modulesDir, entry.name));
  }
  return manifests;
}
