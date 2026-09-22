import type { Pool } from 'pg';
import { createPool } from '@iaxti/db';

let pool: Pool | null = null;
/**
 * Un pool puesto desde afuera (tests).
 *
 * Sin esto, la única forma de que la API hablara con OTRA base era cambiar
 * `process.env.DATABASE_URL`, y eso es una variable del PROCESO: vitest
 * corre varios archivos en hilos que comparten el mismo, así que un test
 * que apuntaba la API a un puerto muerto —para comprobar que un webhook
 * responde 503 y no 500— le cambiaba la base a los que corrían al lado.
 * Fallaban archivos al azar, y parecía culpa de la máquina.
 */
let inyectado: Pool | null = null;

/** Pool único de la API; null si el ambiente no tiene base configurada. */
export function apiPool(): Pool | null {
  if (inyectado) return inyectado;
  if (!process.env.DATABASE_URL) return null;
  if (!pool) pool = createPool();
  return pool;
}

/** Solo para tests: fija el pool que usará la API, sin tocar el entorno. */
export function usarPool(p: Pool | null): void {
  inyectado = p;
}
