import type { Pool, PoolClient } from 'pg';

/**
 * Cerrojo 2 del multi-tenancy (SPEC §27): ejecuta `fn` dentro de una
 * transacción con `app.tenant_id` fijado para la transacción; las políticas
 * RLS lo leen con `current_setting('app.tenant_id', true)`. Fuera de este
 * wrapper, las tablas con RLS forzado no devuelven filas de negocio.
 */
export async function withTenant<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Los ids de tenants sobre los que un barrido tiene que trabajar (#286).
 *
 * Existe porque casi todos los barridos empezaban con una consulta suelta a
 * una tabla de negocio —`SELECT DISTINCT tenant_id FROM appointments ...`— y
 * eso no funciona con el rol de producción: una consulta fuera de
 * `withTenant` corre sin `app.tenant_id`, RLS evalúa `tenant_id = NULL` y
 * devuelve cero filas. En desarrollo no se notaba porque el rol es
 * superusuario y Postgres ni mira las políticas.
 *
 * `tenants` NO tiene RLS, a propósito: es el registro de quiénes existen y
 * es por donde un barrido debe empezar. Después se entra a cada uno con
 * `withTenant` y ahí sí se ve su trabajo.
 *
 * El precio es pasar de una consulta a N. Y resultó ser un problema antes de
 * lo previsto: medido el 09/10, visitar un tenant SIN trabajo cuesta 4,5 ms
 * —una transacción más las consultas de cada paso—, así que mil tenants son
 * minutos de un cron haciendo nada (#580, ADR-0026).
 *
 * De ahí `opts.ids`: quien sepa a quiénes hay que visitar los pasa, y esta
 * consulta no corre. El aislamiento no cambia — se sigue entrando con
 * `withTenant`—; lo que cambia es a quién.
 */
export async function idsDeTenants(
  pool: Pool,
  opts: { estados?: readonly string[]; ids?: readonly string[] } = {},
): Promise<string[]> {
  // Una lista explícita gana: quien la pasó ya averiguó quién tiene trabajo, y
  // volver a consultar `tenants` acá sería preguntar dos veces lo mismo.
  if (opts.ids) return [...opts.ids];
  const estados = opts.estados ?? ['trial', 'active', 'past_due', 'read_only', 'suspended'];
  const r = await pool.query(
    `SELECT id FROM tenants WHERE COALESCE(state, 'active') = ANY($1) ORDER BY created_at`,
    [estados],
  );
  return r.rows.map((x) => x.id as string);
}

/**
 * Recorre los tenants y corre `fn` dentro del contexto de cada uno.
 *
 * Un tenant que falla no puede dejar sin barrer a los demás: se anota y se
 * sigue. Ese detalle importa más de lo que parece — el barrido que se cae en
 * el primer tenant deja a todos los demás sin servicio y solo se nota
 * mirando logs.
 */
/**
 * Cuántos tenants a la vez, derivado del pool y no de un número a dedo (#1290).
 *
 * El pool por omisión es de 6 conexiones (`DB_POOL_MAX`), y cada tenant
 * visitado toma una mientras dura su transacción. Un número fijo se come el
 * pool en el despliegue que lo tenga chico: con `DB_POOL_MAX=2`, una
 * concurrencia de 4 deja al barrido esperándose a sí mismo.
 *
 * Reserva dos: el proceso que corre el barrido también atiende otras cosas, y
 * un barrido que se queda con todas las conexiones es un barrido que tira lo
 * demás. Con un pool de 2 o menos vuelve a ser de a uno, que es el
 * comportamiento de siempre.
 */
function cuantosALaVez(pool: Pool, pedido?: number): number {
  if (pedido !== undefined) return Math.max(1, Math.floor(pedido));
  const delPool = (pool as unknown as { options?: { max?: number } }).options?.max ?? 6;
  return Math.max(1, Math.min(4, delPool - 2));
}

export async function porCadaTenant<T>(
  pool: Pool,
  fn: (client: PoolClient, tenantId: string) => Promise<T>,
  opts: {
    estados?: readonly string[];
    /** A quiénes visitar. Sin esto, a todos los vivos (#580). */
    ids?: readonly string[];
    alFallar?: (tenantId: string, err: Error) => void;
    /**
     * Cuántos tenants a la vez. Sin esto, lo que quepa en el pool dejando dos
     * conexiones libres (#1290).
     *
     * Ponelo en 1 si el barrido necesita orden: con más de uno, los tenants se
     * terminan en el orden en que contesta la base, no en el de la lista. Lo
     * que SÍ se conserva es el orden del valor devuelto.
     */
    concurrencia?: number;
  } = {},
): Promise<T[]> {
  const ids = await idsDeTenants(pool, opts);
  const alFallar =
    opts.alFallar ?? ((t: string, e: Error) => console.error(`barrido: ${t} falló — ${e.message}`));

  /*
   * De a varios, y no de a uno (#1290).
   *
   * Medido: `maintainPartnerInvitations` visitaba 782 tenants en más de 5 s y
   * `sweepResponseSamples` 1.113 en ~5 s, veinticuatro veces al día. La
   * consulta que arma la lista tarda 13–16 ms; lo que costaba eran los ciclos
   * de abrir, fijar el tenant y cerrar —unos 4,5 ms cada uno (#743)—, pagados
   * en serie.
   *
   * Cada tenant abre su propia transacción y no comparte nada con los otros,
   * así que esto es paralelizable sin tocar lo que hace `fn`. Lo que NO se
   * hizo —y se consideró— es un tope de tenants por vuelta: un barrido diario
   * con mil pendientes tardaría cinco días en drenar, y el trabajo que queda
   * sin hacer no lo ve nadie.
   */
  return enParalelo(ids, (t) => withTenant(pool, t, (c) => fn(c, t)), {
    concurrencia: cuantosALaVez(pool, opts.concurrencia),
    alFallar,
  });
}

/**
 * Recorre una lista de tenants de a varios, sin abrir ninguna transacción
 * (#1290).
 *
 * Existe aparte de `porCadaTenant` por una razón concreta, y no por gusto de
 * generalizar: hay barridos cuyo cuerpo **ya abre sus propias transacciones**
 * —`maintainPartnerInvitations` hace un `withTenant` adentro y además llama a
 * funciones que reciben el `Pool`—. Envolverlos con `porCadaTenant` les pondría
 * una transacción de más por tenant, así que con concurrencia 4 sobre un pool
 * de 6 el barrido se bloquearía esperándose a sí mismo.
 *
 * Así que la regla es: si el cuerpo quiere un `PoolClient`, `porCadaTenant`; si
 * se las arregla solo, esto.
 *
 * Devuelve lo que salió bien, EN EL ORDEN de la lista, aunque terminen
 * desordenados. Un tenant que falla se anota y no detiene a los demás: el
 * barrido que se cae en el primero deja a todos los demás sin servicio y solo
 * se nota mirando logs.
 */
export async function enParalelo<T>(
  tenantIds: readonly string[],
  fn: (tenantId: string) => Promise<T>,
  opts: { concurrencia: number; alFallar?: (tenantId: string, err: Error) => void },
): Promise<T[]> {
  const alFallar =
    opts.alFallar ?? ((t: string, e: Error) => console.error(`barrido: ${t} falló — ${e.message}`));
  const resultados: Array<{ ok: true; valor: T } | { ok: false }> = tenantIds.map(() => ({
    ok: false,
  }));
  let siguiente = 0;
  const hilos = Array.from(
    { length: Math.max(1, Math.min(opts.concurrencia, tenantIds.length)) },
    async () => {
      // `siguiente++` no se interrumpe a mitad en un solo hilo de JavaScript,
      // así que dos de estos nunca toman el mismo índice.
      for (let i = siguiente++; i < tenantIds.length; i = siguiente++) {
        try {
          resultados[i] = { ok: true, valor: await fn(tenantIds[i]) };
        } catch (err) {
          alFallar(tenantIds[i], err as Error);
        }
      }
    },
  );
  await Promise.all(hilos);
  // Solo los que salieron bien, y en el orden de la lista: es el contrato que
  // había cuando esto era un `push` dentro de un `for`.
  return resultados.filter((r): r is { ok: true; valor: T } => r.ok).map((r) => r.valor);
}

/** Cuántos tenants a la vez para un barrido que se abre sus propias
 *  transacciones. Mismo cálculo que `porCadaTenant`, expuesto para los que no
 *  pueden usarlo (#1290). */
export function tenantsALaVez(pool: Pool, pedido?: number): number {
  return cuantosALaVez(pool, pedido);
}

/** Descubrir los negocios ANTES de elegir uno (#902).
 * userId viene exclusivamente de una sesión ya autenticada, nunca de un DTO.
 * Solo concede lectura de membresías/roles propios; no habilita tablas de negocio. */
export async function withAuthenticatedUser<T>(
  pool: Pool,
  userId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', '', true), set_config('app.user_id', $1, true)", [userId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
