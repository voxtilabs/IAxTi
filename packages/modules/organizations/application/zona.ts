import type { PoolClient } from 'pg';
import { TZ_POR_DEFECTO } from '@iaxti/core';
import { degradarSinRomper } from '@iaxti/db';

// La zona horaria del negocio (#66, issue 182). `tenants.timezone` existía,
// era editable desde el primer día... y se ignoraba en todas partes: las
// métricas se calculaban siempre con la zona del producto.
//
// Mientras todos los clientes son chilenos eso no se nota. El día que
// alguien ponga una zona distinta —y la columna invita a hacerlo— sus
// números salen mal de la forma más difícil de diagnosticar: no fallan,
// solo cuentan el día equivocado.

/** Las zonas no cambian casi nunca; preguntarlas por evento sí se nota. */
const CACHE = new Map<string, { zona: string; at: number }>();
const TTL_MS = 5 * 60_000;

/**
 * La zona del negocio, degradando a la del producto si no se puede leer.
 *
 * ## Por qué esto pasa por `degradarSinRomper` (#962)
 *
 * Era un `.catch()` sobre la consulta, y la intención era correcta: saber el
 * día del negocio es una mejora, no un requisito, así que si la columna no se
 * puede leer vale más seguir con la zona del producto que tumbar lo que el
 * llamador estaba haciendo.
 *
 * Lo que no era correcto es dónde se aplicaba. Esta función recibe el
 * `PoolClient` de QUIEN LLAMA, y casi siempre viene dentro de una
 * transacción: el despachador del outbox, la purga, el tablero. En Postgres
 * una sentencia que falla aborta el bloque entero, así que tragarse el error
 * no dejaba las cosas como estaban — dejaba la transacción inservible, y todo
 * lo que viniera después contestaba `current transaction is aborted`.
 *
 * Medido con el consumidor de analytics y un rol sin `SELECT` en `tenants`:
 * el evento se agotaba a los cinco intentos y el `last_error` del outbox no
 * nombraba ni `tenants`, ni `timezone`, ni el permiso que faltaba.
 *
 * ## Y el motivo se dice
 *
 * Degradar en silencio fue la otra mitad del problema: nadie podía enterarse
 * de que faltaba un permiso. Ahora el error real sale por `console.warn` con
 * el tenant, que es lo que lleva a alguien a mirar.
 */
export async function zonaDelTenant(client: PoolClient, tenantId: string): Promise<string> {
  const hit = CACHE.get(tenantId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.zona;
  const porDefecto = process.env.IAXTI_TZ || TZ_POR_DEFECTO;

  return degradarSinRomper(
    client,
    async (c) => {
      const r = await c.query<{ timezone: string | null }>(
        'SELECT timezone FROM tenants WHERE id = $1',
        [tenantId],
      );
      const zona = r.rows[0]?.timezone || porDefecto;
      CACHE.set(tenantId, { zona, at: Date.now() });
      return zona;
    },
    (error) => {
      console.warn(
        `organizations.zona: no se pudo leer la zona horaria de ${tenantId}; ` +
          `se sigue con ${porDefecto}. Causa: ${error.message}`,
      );
      // No se cachea: un fallo pasajero no debe fijar la zona equivocada por
      // cinco minutos, y un permiso que falta tiene que seguir avisando hasta
      // que alguien lo arregle.
      return porDefecto;
    },
  );
}

/** Solo para tests: el cache es estado de proceso. */
export function olvidarZonas(): void {
  CACHE.clear();
}
