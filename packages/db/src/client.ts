import { Pool } from 'pg';

/**
 * El pool de la aplicación.
 *
 * Los dos tiempos de espera no son afinado fino: son la diferencia entre que
 * un problema se vea y que no.
 *
 * `pg` viene con `connectionTimeoutMillis: 0`, que significa **esperar para
 * siempre**. Cuando la base no contesta —no que rechace: que se coma los
 * paquetes— cada consulta se queda colgada sin decir nada, y la aplicación
 * se ve viva mientras no puede hacer nada. Es exactamente lo que pasó con
 * staging (#241): `/health` en 200, `/ready` colgado en su propio tope, y
 * ninguna pista de qué estaba mal hasta que se miró desde el otro lado.
 *
 * Con un tope, el mismo problema dice su nombre en los logs a los cinco
 * segundos y en el arranque de cada servicio.
 */
export function createPool(connectionString = process.env.DATABASE_URL): Pool {
  if (!connectionString) {
    throw new Error('DATABASE_URL no está definida');
  }
  return new Pool({
    connectionString,
    // Cinco segundos para CONSEGUIR una conexión. Una base sana en la misma
    // región contesta en menos de uno; cinco deja margen para un arranque
    // frío sin volverse una espera eterna.
    connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5_000),
    // Una conexión ociosa se suelta a los 30 s: el pooler de Supabase tiene
    // un techo de conexiones y guardarlas sin usar se las quita a otro.
    idleTimeoutMillis: 30_000,
  });
}
