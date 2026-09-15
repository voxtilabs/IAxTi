import type { PoolClient } from 'pg';
import { TZ_POR_DEFECTO } from '@iaxti/core';

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

export async function zonaDelTenant(client: PoolClient, tenantId: string): Promise<string> {
  const hit = CACHE.get(tenantId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.zona;
  const r = await client
    .query('SELECT timezone FROM tenants WHERE id = $1', [tenantId])
    .catch(() => ({ rows: [] as Array<{ timezone: string | null }> }));
  const zona = r.rows[0]?.timezone || process.env.IAXTI_TZ || TZ_POR_DEFECTO;
  CACHE.set(tenantId, { zona, at: Date.now() });
  return zona;
}

/** Solo para tests: el cache es estado de proceso. */
export function olvidarZonas(): void {
  CACHE.clear();
}
