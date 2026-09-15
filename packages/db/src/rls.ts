import type { Pool, PoolClient } from 'pg';

/**
 * ¿Esta conexión puede saltarse RLS? (issue 211)
 *
 * Postgres NO evalúa las políticas cuando el rol es superusuario o tiene
 * BYPASSRLS. Da igual que la tabla tenga ENABLE y FORCE y que la política
 * sea perfecta: no se mira. Y no avisa.
 *
 * El aislamiento entre tenants es la promesa central del producto, y hoy
 * depende por completo de CON QUÉ USUARIO se conecta la aplicación. En un
 * Postgres levantado por Dokploy el usuario por defecto es superusuario:
 * basta apuntar ahí el DATABASE_URL para que el aislamiento desaparezca sin
 * un solo error.
 */
export interface EstadoRls {
  rol: string;
  superusuario: boolean;
  bypassrls: boolean;
  /** true si las políticas NO se van a evaluar para esta conexión. */
  seSalta: boolean;
}

export async function estadoRls(client: Pick<Pool, 'query'> | PoolClient): Promise<EstadoRls> {
  const r = await client.query(
    `SELECT current_user AS rol,
            COALESCE(rolsuper, false) AS super,
            COALESCE(rolbypassrls, false) AS bypass
       FROM pg_roles WHERE rolname = current_user`,
  );
  const fila = r.rows[0] ?? { rol: 'desconocido', super: false, bypass: false };
  const superusuario = Boolean(fila.super);
  const bypassrls = Boolean(fila.bypass);
  return {
    rol: String(fila.rol),
    superusuario,
    bypassrls,
    seSalta: superusuario || bypassrls,
  };
}

/**
 * Lo mismo, pero con la decisión tomada, y la decisión es distinta según
 * qué haya del otro lado:
 *
 * - **producción**: revienta el arranque. Ahí hay conversaciones de clientes
 *   de clientes, y servirlas cruzadas es el peor resultado posible. Un 503
 *   al rato sería peor todavía: mientras tanto ya habría cruzado datos.
 * - **staging y el resto**: grita y sigue. En staging no hay datos reales
 *   —nunca un número de WhatsApp de verdad—, así que tumbar el ambiente no
 *   protege a nadie y sí impide trabajar. El aviso se repite cada media
 *   hora para que no se vuelva paisaje.
 *
 * El caso concreto que esto contempla: un Postgres levantado por Dokploy
 * entrega un usuario superusuario, y staging suele ser el primero en
 * apuntar ahí.
 */
export async function exigeRolQueRespetaRls(
  client: Pick<Pool, 'query'> | PoolClient,
  entorno = process.env.IAXTI_ENV ?? 'development',
): Promise<EstadoRls> {
  const estado = await estadoRls(client);
  if (!estado.seSalta) return estado;

  const motivo = estado.superusuario ? 'es superusuario' : 'tiene BYPASSRLS';
  const mensaje =
    `La base acepta esta conexión con el rol "${estado.rol}", que ${motivo}: ` +
    'Postgres NO evalúa las políticas por tenant y los datos de un cliente ' +
    'quedan visibles desde la cuenta de otro. Conecta con un rol de aplicación ' +
    'sin superusuario ni BYPASSRLS (runbook: "el rol de la aplicación").';

  if (entorno === 'production') throw new Error(mensaje);
  console.error(`SIN AISLAMIENTO (${entorno}): ${mensaje}`);
  recordarCadaTanto(entorno, mensaje);
  return estado;
}

/** Un aviso que solo sale al arrancar se pierde en el primer despliegue. */
let recordatorio: ReturnType<typeof setInterval> | null = null;
function recordarCadaTanto(entorno: string, mensaje: string): void {
  if (recordatorio || process.env.NODE_ENV === 'test') return;
  recordatorio = setInterval(
    () => console.error(`SIN AISLAMIENTO (${entorno}): ${mensaje}`),
    30 * 60_000,
  );
  recordatorio.unref?.();
}
