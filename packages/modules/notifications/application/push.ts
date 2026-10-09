import type { PoolClient } from 'pg';

// Push web y móvil (#78, SPEC §21). El transporte real es Web Push con
// VAPID; se inyecta para poder probarlo sin salir a internet y para que el
// módulo no dependa de que la librería esté instalada donde no se usa.
//
// Sin llaves VAPID no se envía nada y se dice por qué: un push que se cree
// enviado y nunca llegó es peor que uno que no se intentó.

export interface PushSubscription {
  id: string;
  userId: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent: string | null;
  /**
   * La salud del dispositivo (#698).
   *
   * `last_ok_at` y `failed_at` se escribían en cada envío y nada las leía: una
   * suscripción que falla desde hace semanas seguía ahí y el producto creía que
   * estaba avisando.
   */
  ultimoOkEl: Date | null;
  ultimaFallaEl: Date | null;
  /** Fallas SEGUIDAS. El éxito la vuelve a cero. */
  fallasSeguidas: number;
  /**
   * Si hay que decirle en pantalla «no estamos pudiendo avisarte en este
   * dispositivo». Se calcula acá y no en la interfaz para que el umbral sea uno.
   */
  avisarQueNoLlega: boolean;
}

export interface PushPayload {
  title: string;
  body?: string | null;
  link?: string | null;
  tag?: string;
}

export type ResultadoPush =
  | { estado: 'enviado' }
  | { estado: 'muerta' }
  | { estado: 'sin_configurar'; motivo: string }
  | { estado: 'error'; motivo: string };

/** El transporte: devuelve el status HTTP del servicio de push. */
export type PushSender = (
  sub: PushSubscription,
  payload: PushPayload,
) => Promise<{ statusCode: number }>;

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export function vapidFromEnv(env: NodeJS.ProcessEnv = process.env): VapidConfig | null {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return null;
  return {
    publicKey: VAPID_PUBLIC_KEY,
    privateKey: VAPID_PRIVATE_KEY,
    // mailto: es lo que exige el estándar para que el servicio sepa a quién reclamar.
    subject: VAPID_SUBJECT ?? 'mailto:soporte@iaxti.cl',
  };
}

function rowToSub(row: Record<string, unknown>): PushSubscription {
  const fallas = Number(row.failed_count ?? 0);
  return {
    id: row.id as string,
    userId: row.user_id as string,
    endpoint: row.endpoint as string,
    keys: { p256dh: row.p256dh as string, auth: row.auth as string },
    userAgent: (row.user_agent as string) ?? null,
    ultimoOkEl: (row.last_ok_at as Date) ?? null,
    ultimaFallaEl: (row.failed_at as Date) ?? null,
    fallasSeguidas: fallas,
    avisarQueNoLlega: fallas >= FALLAS_PARA_AVISAR,
  };
}

/**
 * Alta de una suscripción. Idempotente por endpoint: el mismo navegador que
 * vuelve a suscribirse actualiza sus llaves en vez de duplicarse, y si el
 * endpoint cambió de dueño (equipo compartido), pasa al usuario nuevo.
 */
export async function registerPushSubscription(
  client: PoolClient,
  input: {
    tenantId: string;
    userId: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    userAgent?: string;
  },
): Promise<PushSubscription> {
  const r = await client.query(
    `INSERT INTO push_subscriptions (tenant_id, user_id, endpoint, p256dh, auth, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (endpoint) DO UPDATE SET
       tenant_id = EXCLUDED.tenant_id,
       user_id = EXCLUDED.user_id,
       p256dh = EXCLUDED.p256dh,
       auth = EXCLUDED.auth,
       user_agent = EXCLUDED.user_agent,
       -- Volver a suscribirse DESARCHIVA y empieza de cero (#698). Sin esto, el
       -- dispositivo que falló y el usuario apagó y volvió a activar se quedaba
       -- archivado para siempre: la pantalla decía «activo» y el push no salía
       -- nunca más, en silencio. Lo encontró la prueba.
       failed_at = NULL,
       failed_count = 0,
       archived_at = NULL,
       archived_reason = NULL
     RETURNING *`,
    [input.tenantId, input.userId, input.endpoint, input.p256dh, input.auth, input.userAgent ?? null],
  );
  return rowToSub(r.rows[0]);
}

/**
 * Archiva la suscripción. No la borra (#698).
 *
 * Antes el 404/410 del servicio hacía `DELETE`, con el argumento de que guardar
 * una suscripción muerta es acumular basura. El argumento tiene una parte buena
 * —no hay que seguir intentándolo— y una mala: borraba el rastro de que ese
 * dispositivo recibía avisos, que es justo lo que alguien quiere mirar cuando
 * dice «no me está llegando nada». `.claude/rules/negocio.md` lo zanja: nada se
 * borra, se archiva.
 *
 * El `motivo` queda escrito porque las dos formas de llegar acá no son lo mismo:
 * la persona que quitó el dispositivo a propósito, y el servicio que dijo que ya
 * no existe.
 */
export async function archivePushSubscription(
  client: PoolClient,
  tenantId: string,
  endpoint: string,
  motivo: 'el usuario lo quitó' | 'el servicio dijo que ya no existe',
): Promise<void> {
  await client.query(
    `UPDATE push_subscriptions
        SET archived_at = now(), archived_reason = $3
      WHERE tenant_id = $1 AND endpoint = $2 AND archived_at IS NULL`,
    [tenantId, endpoint, motivo],
  );
}

/**
 * Los dispositivos vivos del usuario.
 *
 * Las archivadas quedan fuera (#698): se archivan y no se borran —SPEC §39— así
 * que hay que excluirlas a mano, o el producto seguiría intentando mandarle a un
 * navegador que ya dijo que no existe.
 */
export async function listPushSubscriptions(
  client: PoolClient,
  tenantId: string,
  userId: string,
): Promise<PushSubscription[]> {
  const r = await client.query(
    `SELECT * FROM push_subscriptions
      WHERE tenant_id = $1 AND user_id = $2 AND archived_at IS NULL
      ORDER BY created_at`,
    [tenantId, userId],
  );
  return r.rows.map(rowToSub);
}

/** Una falla más, seguida: el contador sube y el éxito lo baja a cero (#698). */
async function marcarFalla(client: PoolClient, id: string): Promise<void> {
  await client.query(
    'UPDATE push_subscriptions SET failed_at = now(), failed_count = failed_count + 1 WHERE id = $1',
    [id],
  );
}

/**
 * Cuántas fallas seguidas hacen falta para decirlo en pantalla.
 *
 * Tres y no una: la red de un celular falla sola, y el servicio del navegador
 * tiene malos minutos. Avisar al primer error llenaría la pantalla de avisos
 * falsos, y un aviso falso enseña a ignorar los verdaderos — que es el mismo
 * problema que este issue viene a arreglar, por el otro lado.
 */
export const FALLAS_PARA_AVISAR = 3;

/**
 * Envía a todos los dispositivos del usuario.
 *
 * Una suscripción que el servicio declara muerta (404/410) se ARCHIVA (#698):
 * no se sigue intentando, y el rastro queda.
 */
export async function sendPushToUser(
  client: PoolClient,
  input: {
    tenantId: string;
    userId: string;
    payload: PushPayload;
    sender?: PushSender | null;
  },
): Promise<ResultadoPush[]> {
  const subs = await listPushSubscriptions(client, input.tenantId, input.userId);
  if (subs.length === 0) return [];
  if (!input.sender) {
    return subs.map(() => ({
      estado: 'sin_configurar' as const,
      motivo: 'Faltan las llaves VAPID: el push no sale.',
    }));
  }

  const resultados: ResultadoPush[] = [];
  for (const sub of subs) {
    try {
      const { statusCode } = await input.sender(sub, input.payload);
      if (statusCode === 404 || statusCode === 410) {
        await archivePushSubscription(
          client, input.tenantId, sub.endpoint, 'el servicio dijo que ya no existe',
        );
        resultados.push({ estado: 'muerta' });
      } else if (statusCode >= 200 && statusCode < 300) {
        // El éxito vuelve el contador a cero: lo que importa es fallar N veces
        // SEGUIDAS, no haber fallado alguna vez (#698).
        await client.query(
          `UPDATE push_subscriptions
              SET last_ok_at = now(), failed_at = NULL, failed_count = 0
            WHERE id = $1`,
          [sub.id],
        );
        resultados.push({ estado: 'enviado' });
      } else {
        await marcarFalla(client, sub.id);
        resultados.push({ estado: 'error', motivo: `HTTP ${statusCode}` });
      }
    } catch (err) {
      await marcarFalla(client, sub.id);
      resultados.push({ estado: 'error', motivo: (err as Error).message });
    }
  }
  return resultados;
}

/**
 * Cuántas suscripciones están fallando, para el diagnóstico (#698).
 *
 * Criterio 4 del issue: que se pueda ver, **sin bloquear**. No va en `/ready`
 * —que es público y además decide si el proceso recibe tráfico; un dispositivo
 * de un usuario que no recibe avisos no es razón para sacar de rotación a la
 * API— sino en el diagnóstico de avisos del negocio.
 *
 * Se cuenta solo lo vivo: las archivadas ya no se intentan, así que contarlas
 * sería un número que nunca baja.
 */
export async function saludDelPush(
  client: PoolClient,
  tenantId: string,
): Promise<{
  dispositivos: number;
  fallando: number;
  archivadas: number;
  /**
   * Por qué se archivaron, con su cuenta.
   *
   * Distingue las dos razones, que no son lo mismo: «el usuario lo quitó» es
   * una decisión suya y no hay nada que arreglar; «el servicio dijo que ya no
   * existe» en varios dispositivos a la vez es una señal de que algo nuestro
   * está mal. Sin esto, `archived_reason` sería una columna más que se escribe
   * y nadie lee — justo lo que #703 viene a impedir.
   */
  archivadasPorMotivo: Array<{ motivo: string; n: number }>;
}> {
  const r = await client.query(
    `SELECT count(*) FILTER (WHERE archived_at IS NULL)::int AS dispositivos,
            count(*) FILTER (WHERE archived_at IS NULL AND failed_count >= $2)::int AS fallando,
            count(*) FILTER (WHERE archived_at IS NOT NULL)::int AS archivadas
       FROM push_subscriptions WHERE tenant_id = $1`,
    [tenantId, FALLAS_PARA_AVISAR],
  );
  const motivos = await client.query(
    `SELECT coalesce(archived_reason, 'sin motivo') AS motivo, count(*)::int AS n
       FROM push_subscriptions
      WHERE tenant_id = $1 AND archived_at IS NOT NULL
      GROUP BY 1 ORDER BY n DESC, motivo`,
    [tenantId],
  );
  return {
    ...r.rows[0],
    archivadasPorMotivo: motivos.rows.map((f) => ({ motivo: f.motivo as string, n: f.n as number })),
  };
}
