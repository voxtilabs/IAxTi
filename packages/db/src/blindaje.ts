import type { PoolClient } from 'pg';

/**
 * Que la API de datos de Supabase no vea nada nuestro.
 *
 * Supabase publica TODO el esquema `public` por PostgREST, con la llave
 * anónima que viaja en el navegador, y sus privilegios por defecto le dan a
 * `anon` y `authenticated` permisos sobre cada tabla NUEVA. O sea que el
 * producto publicaba su esquema sin que nadie lo pidiera, y una tabla que
 * alguien agregue el mes que viene vuelve a publicarse sola.
 *
 * Las tablas por tenant estaban tapadas por RLS —una consulta sin
 * `app.tenant_id` devuelve cero filas— pero diez no tienen RLS porque no
 * son de un tenant, y ésas sí quedaban a la vista: entre ellas `tenants`
 * (todos los negocios con su configuración), `user_profiles` y
 * `platform_admins`, que es QUIÉN administra la plataforma.
 *
 * Esto corre DESPUÉS de todas las migraciones y no es una migración: una
 * migración blinda lo que existía el día que se escribió, y el problema es
 * justamente lo que viene después. Acá se recorre el catálogo cada vez.
 *
 * Dos cierres, porque uno solo no alcanza:
 *
 *  1. **Se quitan los permisos.** Es el arreglo de verdad: sin GRANT,
 *     PostgREST no tiene qué leer ni escribir.
 *  2. **RLS encendido igual**, con una política RESTRICTIVA que niega a
 *     esos dos roles. Si mañana alguien vuelve a conceder permisos, la
 *     puerta sigue cerrada. Una política permisiva sola convertiría RLS en
 *     decoración.
 *
 * Lo que este producto usa de Supabase es Auth y Realtime por broadcast; la
 * API de datos no la llama nadie —ni la web, ni el panel, ni los workers—,
 * así que cerrarla entera no le quita nada a nadie.
 */

/**
 * `user_roles` es la excepción, y tiene motivo: la política de
 * `realtime.messages` (#37) comprueba la pertenencia al tenant leyendo esta
 * tabla como `authenticated`, con `user_roles_self`, que solo deja ver la
 * fila propia. Sin ese SELECT, la bandeja deja de actualizarse sola.
 */
const LEE_AUTHENTICATED = 'user_roles';

export interface ResultadoBlindaje {
  /** Tablas a las que se les encendió RLS ahora. */
  conRlsNueva: string[];
  /** true si este Postgres tiene la API de datos (o sea, es Supabase). */
  hayPostgrest: boolean;
  /** Tablas a las que se les quitó el acceso de PostgREST ahora. */
  cerradas: string[];
}

export async function blindarEsquema(client: PoolClient): Promise<ResultadoBlindaje> {
  const conRlsNueva: string[] = [];
  const cerradas: string[] = [];

  // 1 · RLS en todo lo que no la tenga.
  //
  // Sin FORCE a propósito: el dueño tiene que seguir pudiendo migrar y
  // operar. En estas tablas lo que protege es el permiso; la política es el
  // segundo cerrojo, no el primero.
  const sinRls = await client.query<{ tabla: string }>(
    `SELECT c.relname AS tabla
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')`,
  );
  for (const { tabla } of sinRls.rows) {
    await client.query(`ALTER TABLE public.${ident(tabla)} ENABLE ROW LEVEL SECURITY`);
    await client.query(
      `CREATE POLICY acceso_del_producto ON public.${ident(tabla)}
         FOR ALL USING (true) WITH CHECK (true)`,
    );
    conRlsNueva.push(tabla);
  }

  // 2 · Nada para `anon` ni `authenticated`.
  const hayPostgrest =
    (await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'anon'")).rowCount === 1;
  if (!hayPostgrest) return { conRlsNueva, hayPostgrest, cerradas };

  const tablas = await client.query<{ tabla: string }>(
    `SELECT c.relname AS tabla
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'`,
  );
  for (const { tabla } of tablas.rows) {
    const esLaExcepcion = tabla === LEE_AUTHENTICATED;
    await client.query(`REVOKE ALL ON public.${ident(tabla)} FROM anon, authenticated`);
    if (esLaExcepcion) {
      await client.query(`GRANT SELECT ON public.${ident(tabla)} TO authenticated`);
      await client.query(`DROP POLICY IF EXISTS postgrest_no ON public.${ident(tabla)}`);
      continue;
    }
    const yaEsta = await client.query(
      `SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = $1 AND policyname = 'postgrest_no'`,
      [tabla],
    );
    if (yaEsta.rowCount === 0) {
      await client.query(
        `CREATE POLICY postgrest_no ON public.${ident(tabla)}
           AS RESTRICTIVE TO anon, authenticated USING (false)`,
      );
      cerradas.push(tabla);
    }
  }

  // Las funciones: `resolver_api_key` recibe un token y dice a quién
  // pertenece. Ejecutable con la llave anónima sería un oráculo.
  await client.query('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated');
  await client.query('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated');

  // Y lo que venga. Alcanza a lo que cree ESTE rol, que es el que corre las
  // migraciones; si algún día migra otro, hay que repetirlo para él — por
  // eso el paso de arriba recorre el catálogo entero en cada corrida y no
  // se confía solo en esto.
  for (const que of ['TABLES', 'SEQUENCES', 'FUNCTIONS']) {
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON ${que} FROM anon, authenticated`,
    );
  }
  return { conRlsNueva, hayPostgrest, cerradas };
}

/** Identificador citado: los nombres salen del catálogo, no de una entrada. */
function ident(nombre: string): string {
  return `"${nombre.replace(/"/g, '""')}"`;
}
