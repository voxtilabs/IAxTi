import type { Pool, PoolClient } from 'pg';

/**
 * Los módulos que trae el PLAN del tenant (SPEC §6, issue 209).
 *
 * `plan_limits.modules` existía desde el primer día y se usaba en un solo
 * lugar: un informe del SuperAdmin que cuenta cuántos tenants usan cada
 * módulo. Para decidir si un tenant podía ENTRAR a un módulo, nadie la
 * miraba: el portón preguntaba `registry.isActive()`, que es un flag GLOBAL
 * del despliegue, y el mensaje de error hablaba de "tu plan".
 *
 * Resultado: un tenant del plan más barato usaba automatizaciones,
 * conocimiento, integraciones y analítica — justo lo que distingue a los
 * planes de arriba.
 */

/** Los planes cambian poco; preguntarlos en cada request sí se nota. */
const CACHE = new Map<string, { plan: string; modulos: string[]; at: number }>();
const VENDIBLES = { lista: null as string[] | null, at: 0 };
const TTL_MS = 5 * 60_000;

/**
 * Un módulo se cobra por plan si ALGÚN plan lo vende. El resto —identity,
 * channels, whatsapp, notificaciones, platform— es infraestructura: no se
 * vende por separado y no se apaga por plan.
 */
export async function modulosVendibles(client: Pick<Pool, 'query'>): Promise<string[]> {
  if (VENDIBLES.lista && Date.now() - VENDIBLES.at < TTL_MS) return VENDIBLES.lista;
  const r = await client
    .query(
      `SELECT DISTINCT m.module_id
         FROM plan_limits pl
         CROSS JOIN LATERAL jsonb_array_elements_text(pl.modules) AS m(module_id)`,
    )
    .catch(() => ({ rows: [] as Array<{ module_id: string }> }));
  VENDIBLES.lista = r.rows.map((x) => x.module_id);
  VENDIBLES.at = Date.now();
  return VENDIBLES.lista;
}

export async function modulosDelPlan(
  client: PoolClient | Pick<Pool, 'query'>,
  tenantId: string,
): Promise<{ plan: string; modulos: string[] }> {
  const hit = CACHE.get(tenantId);
  if (hit && Date.now() - hit.at < TTL_MS) return { plan: hit.plan, modulos: hit.modulos };
  const r = await client.query(
    `SELECT t.plan, COALESCE(pl.modules, '[]'::jsonb) AS modules
       FROM tenants t LEFT JOIN plan_limits pl ON pl.plan = t.plan
      WHERE t.id = $1`,
    [tenantId],
  );
  const plan = (r.rows[0]?.plan as string) ?? '';
  const modulos = (r.rows[0]?.modules as string[]) ?? [];
  CACHE.set(tenantId, { plan, modulos, at: Date.now() });
  return { plan, modulos };
}

/**
 * ¿Puede este tenant usar el módulo, y cómo?
 *
 * `solo_lectura` es la regla de §6 con todas sus letras: «si el plan nuevo no
 * incluye un módulo activo, el módulo pasa a solo lectura, no se borra».
 * Bajar de plan nunca esconde lo que el cliente ya escribió.
 */
export type AccesoModulo = 'completo' | 'solo_lectura';

export function accesoAlModulo(input: {
  moduleId: string;
  vendibles: string[];
  delPlan: string[];
}): AccesoModulo {
  if (!input.vendibles.includes(input.moduleId)) return 'completo'; // infraestructura
  return input.delPlan.includes(input.moduleId) ? 'completo' : 'solo_lectura';
}

/** Cambiar de plan tiene que verse YA, no en cinco minutos. */
export function olvidarPlan(tenantId: string): void {
  CACHE.delete(tenantId);
}

/** Solo para tests y para cuando cambian los planes en sí. */
export function olvidarPlanes(): void {
  CACHE.clear();
  VENDIBLES.lista = null;
  VENDIBLES.at = 0;
}
