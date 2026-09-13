import { Pool } from 'pg';

export function createPool(connectionString = process.env.DATABASE_URL): Pool {
  if (!connectionString) {
    throw new Error('DATABASE_URL no está definida');
  }
  return new Pool({ connectionString });
}
