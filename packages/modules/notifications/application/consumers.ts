import type { PoolClient } from 'pg';
import type { Consumer, EventEnvelope } from '@iaxti/core';
import {
  TIPOS_CRITICOS,
  TIPOS_LEGIBLES,
  notifyUser,
  type NotificationType,
} from './notifications';
import { sendNotificationEmail } from './email';

// Los consumidores del catálogo (#55): idempotentes por processed_events
// (el despachador entrega UNA vez por consumidor). Aquí se decide QUIÉN
// recibe cada aviso; las preferencias filtran campana y correo.

interface Aviso {
  type: NotificationType;
  title: string;
  body?: string;
  link?: string;
  recipients: string[];
}

/** Supervisores y admins del tenant: routing de avisos, no autorización
 *  (ADR-0008 gobierna permisos; a quién se le avisa es otra pregunta). */
async function supervisores(client: PoolClient, tenantId: string): Promise<string[]> {
  const r = await client.query(
    `SELECT ur.user_id FROM user_roles ur JOIN roles ro ON ro.id = ur.role_id
      WHERE ur.tenant_id = $1 AND ro.name IN ('SUPERVISOR', 'ADMIN')`,
    [tenantId],
  );
  return r.rows.map((row) => row.user_id);
}

async function admins(client: PoolClient, tenantId: string): Promise<string[]> {
  const r = await client.query(
    `SELECT ur.user_id FROM user_roles ur JOIN roles ro ON ro.id = ur.role_id
      WHERE ur.tenant_id = $1 AND ro.name = 'ADMIN'`,
    [tenantId],
  );
  return r.rows.map((row) => row.user_id);
}

async function avisoDe(event: EventEnvelope, client: PoolClient): Promise<Aviso | null> {
  const p = event.payload as Record<string, unknown>;
  switch (event.name) {
    case 'conversation.unattended':
      return {
        type: 'conversacion_sin_dueno',
        title: TIPOS_LEGIBLES.conversacion_sin_dueno,
        body: `Lleva ${p.waitingMinutes ?? '?'} minutos esperando que alguien la tome.`,
        link: '/bandeja',
        recipients: await supervisores(client, event.tenantId),
      };
    case 'sla.first_response_breached':
      return {
        type: 'sla_vencido',
        title: TIPOS_LEGIBLES.sla_vencido,
        body: 'Una conversación superó el tiempo máximo de primera respuesta.',
        link: '/bandeja',
        recipients: await supervisores(client, event.tenantId),
      };
    case 'note.mentioned':
      return {
        type: 'mencion',
        title: TIPOS_LEGIBLES.mencion,
        body: typeof p.excerpt === 'string' ? p.excerpt : undefined,
        link: '/bandeja',
        recipients: Array.isArray(p.mentions) ? (p.mentions as string[]) : [],
      };
    case 'activity.due': {
      const owner = typeof p.ownerId === 'string' ? [p.ownerId] : await admins(client, event.tenantId);
      return {
        type: 'tarea_vencida',
        title: TIPOS_LEGIBLES.tarea_vencida,
        body: typeof p.title === 'string' ? p.title : undefined,
        link: typeof p.contactId === 'string' ? `/contactos/${p.contactId}` : undefined,
        recipients: owner,
      };
    }
    case 'agent.quota_threshold':
      return {
        type: 'cuota_ia',
        title: TIPOS_LEGIBLES.cuota_ia,
        body: 'Revisa el consumo del asistente antes de que se agote.',
        recipients: await admins(client, event.tenantId),
      };
    case 'number.quality_changed': {
      if (p.to !== 'red') return null; // solo la caída importa como aviso
      return {
        type: 'calidad_numero',
        title: TIPOS_LEGIBLES.calidad_numero,
        body: 'Meta bajó la calidad a rojo: pausamos los envíos del negocio para proteger el número.',
        link: '/ajustes/canales',
        recipients: await admins(client, event.tenantId),
      };
    }
    default:
      return null;
  }
}

async function preferenciasDe(
  client: PoolClient,
  tenantId: string,
  userIds: string[],
  type: NotificationType,
): Promise<Map<string, { campana: boolean; correo: boolean }>> {
  if (userIds.length === 0) return new Map();
  const r = await client.query(
    `SELECT user_id, campana, correo FROM notification_preferences
      WHERE tenant_id = $1 AND type = $2 AND user_id = ANY($3::uuid[])`,
    [tenantId, type, userIds],
  );
  return new Map(r.rows.map((row) => [row.user_id, { campana: row.campana, correo: row.correo }]));
}

export async function handleNotifiableEvent(event: EventEnvelope, client: PoolClient): Promise<void> {
  const aviso = await avisoDe(event, client);
  if (!aviso || aviso.recipients.length === 0) return;
  const prefs = await preferenciasDe(client, event.tenantId, aviso.recipients, aviso.type);
  const critica = TIPOS_CRITICOS.has(aviso.type);
  const adminIds = critica ? new Set(await admins(client, event.tenantId)) : new Set<string>();

  for (const userId of new Set(aviso.recipients)) {
    const pref = prefs.get(userId) ?? { campana: true, correo: true };
    const bloqueada = critica && adminIds.has(userId); // crítica: no silenciable
    await notifyUser(client, {
      tenantId: event.tenantId,
      userId,
      type: aviso.type,
      title: aviso.title,
      body: aviso.body,
      link: aviso.link,
      campana: bloqueada ? true : pref.campana,
    });
    if (bloqueada || pref.correo) {
      // Mejor-esfuerzo: sin SMTP configurado no hace nada; un rebote no
      // debe reintentar el evento completo (la campana ya quedó).
      await sendNotificationEmail(client, {
        tenantId: event.tenantId,
        userId,
        title: aviso.title,
        body: aviso.body,
        link: aviso.link,
      }).catch(() => {});
    }
  }
}

const EVENTOS = [
  'conversation.unattended',
  'sla.first_response_breached',
  'note.mentioned',
  'activity.due',
  'agent.quota_threshold',
  'number.quality_changed',
] as const;

/** Para registrar en el despachador de workers. */
export function notificationConsumers(): Consumer[] {
  return EVENTOS.map((event) => ({
    name: `notifications.${event}`,
    moduleId: 'notifications',
    event,
    handler: handleNotifiableEvent,
  }));
}
