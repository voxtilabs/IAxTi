import type { Pool, PoolClient } from 'pg';

/**
 * ¿Este rol puede hacer TODO lo que la aplicación necesita? (#370)
 *
 * `estadoRls` responde la mitad de la pregunta: si la conexión se salta las
 * políticas. Pero cambiar el rol por uno que las respete puede romper el
 * producto de la otra punta — un `GRANT` que faltó se ve como
 * `permission denied` en medio de un mensaje entrante, en producción, a las
 * tres de la mañana.
 *
 * Esto es lo que se corre ANTES de cambiar la cadena de conexión: con el rol
 * nuevo, dice qué le falta y qué le sobra, sin escribir una sola fila. Las
 * tablas y funciones NO están enumeradas a mano: se preguntan al catálogo,
 * así una migración futura queda cubierta sola.
 *
 * Lo que espera encontrar, que es el runbook hecho consulta:
 *  - USAGE en el esquema;
 *  - las cuatro operaciones en cada tabla nuestra, salvo el libro de
 *    auditoría, que es append-only y donde UPDATE y DELETE SOBRAN;
 *  - USAGE y SELECT en las secuencias;
 *  - EXECUTE en nuestras funciones (las de una extensión no son nuestras);
 *  - y que el rol NO sea superusuario ni tenga BYPASSRLS, porque entonces
 *    nada de lo anterior importa.
 */
export interface FaltaDelRol {
  objeto: string;
  privilegio: string;
  /** Qué se rompe sin esto, en una línea. */
  consecuencia: string;
}

export interface DiagnosticoDelRol {
  rol: string;
  seSalta: boolean;
  faltan: FaltaDelRol[];
  /** Permisos de más: hoy solo el libro de auditoría, que no se toca. */
  sobran: FaltaDelRol[];
  /** true si se puede apuntar la aplicación a este rol sin romper nada. */
  listo: boolean;
}

/** El libro no se corrige: el trigger ya lo rechaza, y el permiso tampoco va. */
const APPEND_ONLY: Record<string, string[]> = {
  audit_log: ['UPDATE', 'DELETE'],
  platform_audit: ['UPDATE', 'DELETE'],
};

/**
 * Las migraciones NO las corre la aplicación (runbook): su tabla es del
 * dueño. Con SELECT alcanza para que el arranque sepa en qué versión está.
 */
const SOLO_LECTURA = new Set(['schema_migrations']);

const OPERACIONES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const;

export async function permisosDelRol(
  client: Pick<Pool, 'query'> | PoolClient,
  rol?: string,
): Promise<DiagnosticoDelRol> {
  const quien = rol ?? (await client.query('SELECT current_user AS r')).rows[0].r;

  const banderas = await client.query(
    `SELECT COALESCE(rolsuper, false) AS s, COALESCE(rolbypassrls, false) AS b
       FROM pg_roles WHERE rolname = $1`,
    [quien],
  );
  if (banderas.rowCount === 0) {
    return {
      rol: quien,
      seSalta: false,
      listo: false,
      sobran: [],
      faltan: [
        {
          objeto: `rol ${quien}`,
          privilegio: 'EXISTIR',
          consecuencia: 'La base no conoce este rol: la aplicación no podría ni conectarse.',
        },
      ],
    };
  }
  const seSalta = Boolean(banderas.rows[0].s) || Boolean(banderas.rows[0].b);

  const faltan: FaltaDelRol[] = [];
  const sobran: FaltaDelRol[] = [];

  if (seSalta) {
    faltan.push({
      objeto: `rol ${quien}`,
      privilegio: 'NOSUPERUSER NOBYPASSRLS',
      consecuencia:
        'Postgres no evalúa las políticas por tenant para este rol: el aislamiento no existe, ' +
        'aunque todos los permisos de abajo estén bien.',
    });
  }

  const esquema = await client.query('SELECT has_schema_privilege($1, $2, $3) AS ok', [
    quien,
    'public',
    'USAGE',
  ]);
  if (!esquema.rows[0].ok) {
    faltan.push({
      objeto: 'esquema public',
      privilegio: 'USAGE',
      consecuencia: 'Sin esto no ve ninguna tabla: la aplicación no arranca.',
    });
  }

  const tablas = await client.query(
    `SELECT c.relname AS tabla
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND NOT EXISTS (
          SELECT 1 FROM pg_depend d
           WHERE d.objid = c.oid AND d.deptype = 'e')
      ORDER BY 1`,
  );
  for (const { tabla } of tablas.rows as Array<{ tabla: string }>) {
    const prohibidos = APPEND_ONLY[tabla] ?? [];
    const necesarios = SOLO_LECTURA.has(tabla)
      ? (['SELECT'] as const)
      : OPERACIONES.filter((op) => !prohibidos.includes(op));
    for (const op of OPERACIONES) {
      const r = await client.query('SELECT has_table_privilege($1, $2, $3) AS ok', [quien, tabla, op]);
      const tiene = Boolean(r.rows[0].ok);
      if (tiene && prohibidos.includes(op)) {
        sobran.push({
          objeto: `tabla ${tabla}`,
          privilegio: op,
          consecuencia:
            'El libro de auditoría es append-only: un permiso que nadie usa es un permiso ' +
            'que alguien puede usar.',
        });
        continue;
      }
      if (!tiene && (necesarios as readonly string[]).includes(op)) {
        faltan.push({
          objeto: `tabla ${tabla}`,
          privilegio: op,
          consecuencia: `La aplicación falla con "permission denied for table ${tabla}".`,
        });
      }
    }
  }

  const secuencias = await client.query(
    `SELECT c.relname AS sec
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'S' ORDER BY 1`,
  );
  for (const { sec } of secuencias.rows as Array<{ sec: string }>) {
    for (const op of ['USAGE', 'SELECT'] as const) {
      const r = await client.query('SELECT has_sequence_privilege($1, $2, $3) AS ok', [quien, sec, op]);
      if (!r.rows[0].ok) {
        faltan.push({
          objeto: `secuencia ${sec}`,
          privilegio: op,
          consecuencia: 'Los INSERT que dependen de esta secuencia fallan.',
        });
      }
    }
  }

  // Las de pgvector vienen con la extensión y no son nuestras: se filtran
  // por `pg_depend`, no por una lista de nombres que envejece.
  const funciones = await client.query(
    `SELECT p.oid::regprocedure::text AS f
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND NOT EXISTS (
          SELECT 1 FROM pg_depend d
           WHERE d.objid = p.oid AND d.deptype = 'e')
      ORDER BY 1`,
  );
  for (const { f } of funciones.rows as Array<{ f: string }>) {
    const r = await client.query('SELECT has_function_privilege($1, $2, $3) AS ok', [quien, f, 'EXECUTE']);
    if (!r.rows[0].ok) {
      faltan.push({
        objeto: `función ${f}`,
        privilegio: 'EXECUTE',
        consecuencia:
          'Las políticas y los triggers que la llaman fallan, o peor: la autenticación por ' +
          'API key rechaza todo sin decir por qué.',
      });
    }
  }

  return { rol: quien, seSalta, faltan, sobran, listo: faltan.length === 0 };
}

/** El diagnóstico en texto, para el paso previo a cambiar la conexión. */
export function comoSeLee(d: DiagnosticoDelRol): string {
  const lineas = [`rol "${d.rol}"`];
  lineas.push(d.seSalta ? '  SE SALTA RLS: el aislamiento no se evalúa.' : '  respeta RLS.');
  if (d.faltan.length === 0) lineas.push('  no le falta ningún permiso.');
  for (const f of d.faltan) lineas.push(`  FALTA  ${f.privilegio} en ${f.objeto} — ${f.consecuencia}`);
  for (const s of d.sobran) lineas.push(`  SOBRA  ${s.privilegio} en ${s.objeto} — ${s.consecuencia}`);
  lineas.push(d.listo ? '  LISTO para ser el rol de la aplicación.' : '  NO se puede apuntar la aplicación acá todavía.');
  return lineas.join('\n');
}
