import type { Pool, PoolClient } from 'pg';

/**
 * Hacer una limpieza que un trigger de inmutabilidad prohíbe, SIN apagarlo
 * para el resto de la base.
 *
 * ## El problema
 *
 * Trece lugares de las pruebas hacen `ALTER TABLE … DISABLE TRIGGER` para
 * poder borrar sus propias filas: `audit_log` es append-only por trigger y un
 * `payment_links` pagado es inmutable por trigger, así que el `afterAll` que
 * limpia no puede borrar nada sin apagarlo.
 *
 * `ALTER TABLE … DISABLE TRIGGER` es **de la tabla**, no de la sesión. Vitest
 * corre los archivos de prueba en paralelo contra la MISMA base, así que
 * mientras uno limpia, el trigger no existe para nadie.
 *
 * Medido: `payments/tests/borrar-un-link.test.ts` lo apaga tres veces para
 * borrar sus links pagados, y `payments/tests/payments.test.ts:328` afirma que
 * ese mismo trigger rechaza un `UPDATE` sobre un link pagado. Cuando las dos
 * ventanas se cruzan, la segunda recibe `Result { command: 'UPDATE' }` donde
 * esperaba un rechazo. Pasó en CI el 11/10 (corrida 38156864280) en un PR que
 * no tocaba pagos.
 *
 * Y el daño no es el rojo: es que **ese rojo no habla del cambio**. Un rojo
 * que no habla del cambio enseña a correr CI de nuevo hasta que pase, y el día
 * que la inmutabilidad se rompa de verdad, el rojo se va a leer igual.
 *
 * ## Por qué `session_replication_role`
 *
 * Porque es **de la sesión**. En `replica`, Postgres no dispara los triggers
 * de usuario de esa conexión y de ninguna otra. Es el mismo permiso que ya
 * hacía falta para el `ALTER TABLE`, y no deja una ventana abierta para los
 * demás archivos.
 *
 * Tiene un efecto que hay que saber: en `replica` tampoco se disparan los
 * triggers internos de las claves foráneas. Para una limpieza que borra todo
 * lo del caso eso es cómodo —el orden de los `DELETE` deja de importar— pero
 * NO sirve para probar comportamiento: acá se limpia, no se afirma.
 *
 * ## Por qué vive en `packages/db` y no en `core/testing`
 *
 * Porque es lo mismo que `withTenant`: un ajuste de SESIÓN de Postgres
 * envolviendo un callback. Y porque `module-audit` —el que más lo necesita—
 * depende solo de `@iaxti/db` y `pg` a propósito: es el módulo de más abajo,
 * todos le escriben y él no conoce a nadie. Traerle `@iaxti/core` para una
 * primitiva de limpieza habría sido pagar con arquitectura una comodidad.
 *
 * ## Uso
 *
 * ```ts
 * await sinTriggers(admin, (c) => c.query('DELETE FROM audit_log WHERE tenant_id = $1', [tenant]));
 * ```
 *
 * El cliente llega por parámetro a propósito: el ajuste vive en la sesión, y
 * un `pool.query` puede tomar otra conexión en la consulta siguiente.
 */
export async function sinTriggers<T>(
  pool: Pool,
  limpiar: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("SET session_replication_role = 'replica'");
    const resultado = await limpiar(client);
    await client.query("SET session_replication_role = 'origin'");
    client.release();
    return resultado;
  } catch (err) {
    // Si no se pudo devolver la sesión a `origin`, el cliente vuelve al pool
    // SIN triggers y el próximo que lo tome escribe sin ellos. Se destruye:
    // una conexión menos es más barata que una conexión mentirosa.
    client.release(err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
}
