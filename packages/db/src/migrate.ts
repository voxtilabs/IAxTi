import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import type { Pool } from 'pg';

interface ModuleManifest {
  module: { id: string };
  depends_on?: { required?: string[] };
}

export interface AppliedMigration {
  module: string;
  version: string;
}

/** Busca packages/modules subiendo desde cwd; MODULES_DIR lo fija explícito. */
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

/** Orden topológico por depends_on.required (Kahn). Ciclo o dep desconocida abortan. */
export function topologicalOrder(modulesDir: string): string[] {
  const ids: string[] = [];
  const deps = new Map<string, string[]>();

  for (const entry of readdirSync(modulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(modulesDir, entry.name, 'module.yaml');
    if (!existsSync(manifestPath)) continue;
    const manifest = parse(readFileSync(manifestPath, 'utf8')) as ModuleManifest;
    const id = manifest.module.id;
    ids.push(id);
    deps.set(id, manifest.depends_on?.required ?? []);
  }

  for (const [id, required] of deps) {
    for (const dep of required) {
      if (!deps.has(dep)) {
        throw new Error(`El módulo "${id}" requiere "${dep}", que no existe en ${modulesDir}`);
      }
    }
  }

  const inDegree = new Map(ids.map((id) => [id, deps.get(id)?.length ?? 0]));

  const queue = ids.filter((id) => inDegree.get(id) === 0).sort();
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    order.push(id);
    for (const [candidate, required] of deps) {
      if (required.includes(id)) {
        const remaining = (inDegree.get(candidate) ?? 0) - 1;
        inDegree.set(candidate, remaining);
        if (remaining === 0) {
          queue.push(candidate);
          queue.sort();
        }
      }
    }
  }

  if (order.length !== ids.length) {
    const pending = ids.filter((id) => !order.includes(id));
    throw new Error(`Ciclo de dependencias entre módulos: ${pending.join(', ')}`);
  }
  return order;
}

/**
 * Aplica las migraciones de packages/modules en orden topológico, cada
 * archivo en su propia transacción, registrando en schema_migrations.
 * Serializado con advisory lock: seguro de correr desde CI antes del deploy
 * (SPEC §37: nunca dentro del contenedor al arrancar).
 */
export async function runMigrations(pool: Pool, modulesDir = findModulesDir()): Promise<AppliedMigration[]> {
  const applied: AppliedMigration[] = [];
  const lock = await pool.connect();
  try {
    await lock.query("SELECT pg_advisory_lock(hashtext('iaxti_migrations'))");
    await lock.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        module     text        NOT NULL,
        version    text        NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (module, version)
      )
    `);

    for (const moduleId of topologicalOrder(modulesDir)) {
      const dir = join(modulesDir, moduleId, 'migrations');
      if (!existsSync(dir)) continue;
      const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

      for (const file of files) {
        const done = await lock.query(
          'SELECT 1 FROM schema_migrations WHERE module = $1 AND version = $2',
          [moduleId, file],
        );
        if ((done.rowCount ?? 0) > 0) continue;

        const sql = readFileSync(join(dir, file), 'utf8');
        try {
          await lock.query('BEGIN');
          await lock.query(sql);
          await lock.query(
            'INSERT INTO schema_migrations (module, version) VALUES ($1, $2)',
            [moduleId, file],
          );
          await lock.query('COMMIT');
          applied.push({ module: moduleId, version: file });
        } catch (error) {
          await lock.query('ROLLBACK');
          throw new Error(`Migración ${moduleId}/${file} falló: ${(error as Error).message}`);
        }
      }
    }
    return applied;
  } finally {
    await lock.query("SELECT pg_advisory_unlock(hashtext('iaxti_migrations'))");
    lock.release();
  }
}
