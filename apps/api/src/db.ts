import type { Pool } from 'pg';
import { createPool } from '@iaxti/db';

let pool: Pool | null = null;

/** Pool único de la API; null si el ambiente no tiene base configurada. */
export function apiPool(): Pool | null {
  if (!process.env.DATABASE_URL) return null;
  if (!pool) pool = createPool();
  return pool;
}
