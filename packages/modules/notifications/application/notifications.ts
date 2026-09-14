import type { PoolClient } from 'pg';

// notifications (#55, SPEC §21): que los avisos lleguen aunque nadie mire
// la pantalla, sin inundar a nadie.

export const NOTIFICATION_TYPES = [
  'conversacion_sin_dueno',
  'sla_vencido',
  'mencion',
  'tarea_vencida',
  'cuota_ia',
  'calidad_numero',
  'pago_recibido',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Los críticos no se silencian para el ADMIN (SPEC §21). */
export const TIPOS_CRITICOS: ReadonlySet<NotificationType> = new Set(['calidad_numero']);

export const TIPOS_LEGIBLES: Record<NotificationType, string> = {
  conversacion_sin_dueno: 'Conversación nueva sin dueño',
  sla_vencido: 'Primera respuesta fuera de plazo',
  mencion: 'Te mencionaron en una nota',
  tarea_vencida: 'Actividad vencida',
  cuota_ia: 'Cuota de IA por agotarse',
  calidad_numero: 'Calidad del número de WhatsApp',
  pago_recibido: 'Pago recibido',
};

export interface Notification {
  id: string;
  userId: string;
  type: NotificationType;
  title: string;
  body: string | null;
  link: string | null;
  groupCount: number;
  readAt: Date | null;
  createdAt: Date;
}

function rowToNotification(row: Record<string, unknown>): Notification {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    type: row.type as NotificationType,
    title: row.title as string,
    body: (row.body as string) ?? null,
    link: (row.link as string) ?? null,
    groupCount: row.group_count as number,
    readAt: (row.read_at as Date) ?? null,
    createdAt: row.created_at as Date,
  };
}

/** Ventana de agrupación anti-inundación: la ráfaga suma, no apila. */
const GROUP_WINDOW_MIN = 30;

export async function notifyUser(
  client: PoolClient,
  input: {
    tenantId: string;
    userId: string;
    type: NotificationType;
    title: string;
    body?: string;
    link?: string;
    /** false salta la campana (preferencia del usuario). */
    campana?: boolean;
  },
): Promise<{ grouped: boolean } | null> {
  if (input.campana === false) return null;
  // Ráfaga del mismo tipo sin leer → se agrupa en la misma fila.
  const existente = await client.query(
    `UPDATE notifications SET
       group_count = group_count + 1,
       title = $4, body = $5, link = COALESCE($6, link), updated_at = now()
     WHERE tenant_id = $1 AND user_id = $2 AND type = $3 AND read_at IS NULL
       AND created_at > now() - make_interval(mins => ${GROUP_WINDOW_MIN})
     RETURNING id`,
    [input.tenantId, input.userId, input.type, input.title, input.body ?? null, input.link ?? null],
  );
  if ((existente.rowCount ?? 0) > 0) return { grouped: true };
  await client.query(
    `INSERT INTO notifications (tenant_id, user_id, type, title, body, link)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [input.tenantId, input.userId, input.type, input.title, input.body ?? null, input.link ?? null],
  );
  return { grouped: false };
}

export async function listNotifications(
  client: PoolClient,
  tenantId: string,
  userId: string,
  limit = 20,
): Promise<{ items: Notification[]; unread: number }> {
  const r = await client.query(
    `SELECT * FROM notifications WHERE tenant_id = $1 AND user_id = $2
      ORDER BY created_at DESC LIMIT $3`,
    [tenantId, userId, Math.min(limit, 50)],
  );
  const u = await client.query(
    `SELECT count(*)::int AS n FROM notifications
      WHERE tenant_id = $1 AND user_id = $2 AND read_at IS NULL`,
    [tenantId, userId],
  );
  return { items: r.rows.map(rowToNotification), unread: u.rows[0].n };
}

export async function markRead(
  client: PoolClient,
  input: { tenantId: string; userId: string; ids?: string[] },
): Promise<number> {
  const r = input.ids?.length
    ? await client.query(
        `UPDATE notifications SET read_at = now()
          WHERE tenant_id = $1 AND user_id = $2 AND read_at IS NULL AND id = ANY($3::uuid[])`,
        [input.tenantId, input.userId, input.ids],
      )
    : await client.query(
        `UPDATE notifications SET read_at = now()
          WHERE tenant_id = $1 AND user_id = $2 AND read_at IS NULL`,
        [input.tenantId, input.userId],
      );
  return r.rowCount ?? 0;
}

export interface Preference {
  type: NotificationType;
  campana: boolean;
  correo: boolean;
  /** true = este usuario no puede apagarla (crítica para ADMIN). */
  bloqueada: boolean;
}

export async function getPreferences(
  client: PoolClient,
  tenantId: string,
  userId: string,
  esAdmin: boolean,
): Promise<Preference[]> {
  const r = await client.query(
    'SELECT type, campana, correo FROM notification_preferences WHERE tenant_id = $1 AND user_id = $2',
    [tenantId, userId],
  );
  const guardadas = new Map(r.rows.map((row) => [row.type, row]));
  return NOTIFICATION_TYPES.map((type) => {
    const bloqueada = esAdmin && TIPOS_CRITICOS.has(type);
    const fila = guardadas.get(type);
    return {
      type,
      campana: bloqueada ? true : (fila?.campana ?? true),
      correo: bloqueada ? true : (fila?.correo ?? true),
      bloqueada,
    };
  });
}

export async function setPreference(
  client: PoolClient,
  input: {
    tenantId: string;
    userId: string;
    type: NotificationType;
    campana: boolean;
    correo: boolean;
    esAdmin: boolean;
  },
): Promise<void> {
  if (input.esAdmin && TIPOS_CRITICOS.has(input.type) && (!input.campana || !input.correo)) {
    throw new Error('Este aviso es crítico para quien administra: no se puede silenciar.');
  }
  await client.query(
    `INSERT INTO notification_preferences (tenant_id, user_id, type, campana, correo)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, user_id, type)
       DO UPDATE SET campana = EXCLUDED.campana, correo = EXCLUDED.correo`,
    [input.tenantId, input.userId, input.type, input.campana, input.correo],
  );
}
