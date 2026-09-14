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
  return {
    id: row.id as string,
    userId: row.user_id as string,
    endpoint: row.endpoint as string,
    keys: { p256dh: row.p256dh as string, auth: row.auth as string },
    userAgent: (row.user_agent as string) ?? null,
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
       failed_at = NULL
     RETURNING *`,
    [input.tenantId, input.userId, input.endpoint, input.p256dh, input.auth, input.userAgent ?? null],
  );
  return rowToSub(r.rows[0]);
}

export async function deletePushSubscription(
  client: PoolClient,
  tenantId: string,
  endpoint: string,
): Promise<void> {
  await client.query('DELETE FROM push_subscriptions WHERE tenant_id = $1 AND endpoint = $2', [
    tenantId,
    endpoint,
  ]);
}

export async function listPushSubscriptions(
  client: PoolClient,
  tenantId: string,
  userId: string,
): Promise<PushSubscription[]> {
  const r = await client.query(
    'SELECT * FROM push_subscriptions WHERE tenant_id = $1 AND user_id = $2 ORDER BY created_at',
    [tenantId, userId],
  );
  return r.rows.map(rowToSub);
}

/**
 * Envía a todos los dispositivos del usuario. Una suscripción que el
 * servicio declara muerta (404/410) SE BORRA: guardarla es acumular basura
 * que falla para siempre.
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
        await deletePushSubscription(client, input.tenantId, sub.endpoint);
        resultados.push({ estado: 'muerta' });
      } else if (statusCode >= 200 && statusCode < 300) {
        await client.query('UPDATE push_subscriptions SET last_ok_at = now() WHERE id = $1', [sub.id]);
        resultados.push({ estado: 'enviado' });
      } else {
        await client.query('UPDATE push_subscriptions SET failed_at = now() WHERE id = $1', [sub.id]);
        resultados.push({ estado: 'error', motivo: `HTTP ${statusCode}` });
      }
    } catch (err) {
      await client.query('UPDATE push_subscriptions SET failed_at = now() WHERE id = $1', [sub.id]);
      resultados.push({ estado: 'error', motivo: (err as Error).message });
    }
  }
  return resultados;
}
