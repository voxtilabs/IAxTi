import type { PoolClient } from 'pg';
import type { Consumer, EventEnvelope } from '@iaxti/core';
import {
  TIPOS_CRITICOS,
  TIPOS_LEGIBLES,
  notifyUser,
  type NotificationType,
} from './notifications';
import { sendNotificationEmail } from './email';
import { sendPushToUser, type PushSender } from './push';
import { dispatchTeamWhatsApp, type EnvioEquipo } from './equipo-whatsapp';

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

/**
 * Qué decirle al dueño según a dónde fue a parar su cuenta (issue 273).
 *
 * `tenant.state_changed` se publicaba desde el barrido de facturación y no
 * lo consumía nadie: a un negocio se le vencía la prueba, la cuenta pasaba a
 * solo lectura, dejaba de poder escribirle a sus clientes — y se enteraba
 * cuando lo intentaba.
 *
 * El texto dice qué pasó y qué hacer, en ese orden. Nada de "el estado de su
 * organización ha sido actualizado".
 */
const TEXTO_POR_ESTADO: Record<string, { titulo: string; cuerpo: string }> = {
  read_only: {
    titulo: 'Tu cuenta quedó en solo lectura',
    cuerpo:
      'Puedes ver todo lo que tienes, pero no enviar mensajes ni crear nada nuevo. ' +
      'Elige un plan para volver a trabajar normalmente.',
  },
  past_due: {
    titulo: 'Tienes una factura impaga',
    cuerpo:
      'Págala para que la cuenta siga funcionando. Si pasa la fecha de gracia, ' +
      'la cuenta queda en solo lectura.',
  },
  suspended: {
    titulo: 'Tu cuenta quedó suspendida',
    cuerpo:
      'Tus datos siguen ahí y no se borra nada. Para reactivarla, elige un plan ' +
      'o escríbenos.',
  },
};

async function avisoDe(event: EventEnvelope, client: PoolClient): Promise<Aviso | null> {
  const p = event.payload as Record<string, unknown>;
  switch (event.name) {
    case 'payment.received': {
      // El dueño de la conversación primero; sin dueño, la supervisión.
      const destinatarios = new Set(await supervisores(client, event.tenantId));
      if (p.conversationId) {
        const conv = await client.query(
          'SELECT owner_id FROM conversations WHERE tenant_id = $1 AND id = $2',
          [event.tenantId, p.conversationId],
        );
        if (conv.rows[0]?.owner_id) destinatarios.add(conv.rows[0].owner_id);
      }
      const monto = Number(p.amountClp);
      return {
        type: 'pago_recibido',
        title: TIPOS_LEGIBLES.pago_recibido,
        body: Number.isFinite(monto) ? `Entraron $${monto.toLocaleString('es-CL')}.` : undefined,
        link: p.conversationId ? '/bandeja' : '/ajustes/pagos',
        recipients: [...destinatarios],
      };
    }
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
    case 'tenant.deletion_warned': {
      const dias = Number(p.diasRestantes ?? 0);
      return {
        type: 'estado_cuenta',
        title: 'Tus datos se van a eliminar',
        body:
          `Tu cuenta lleva meses suspendida y en ${dias} días eliminamos los datos. ` +
          'Descarga tu respaldo desde Ajustes, o elige un plan para recuperar la cuenta.',
        link: '/ajustes/plan',
        recipients: await admins(client, event.tenantId),
      };
    }
    case 'tenant.state_changed': {
      // A quién se le avisa: al ADMIN, que es quien puede hacer algo.
      const texto = TEXTO_POR_ESTADO[String(p.to)];
      // Un cambio que no le cambia la vida a nadie (por ejemplo volver a
      // 'active' desde 'trial' porque eligió plan) no se avisa: la campana
      // vale por lo que interrumpe, no por lo que registra.
      if (!texto) return null;
      return {
        type: 'estado_cuenta',
        title: texto.titulo,
        body: texto.cuerpo,
        link: '/ajustes/plan',
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
): Promise<Map<string, { campana: boolean; correo: boolean; push: boolean }>> {
  if (userIds.length === 0) return new Map();
  const r = await client.query(
    `SELECT user_id, campana, correo, push FROM notification_preferences
      WHERE tenant_id = $1 AND type = $2 AND user_id = ANY($3::uuid[])`,
    [tenantId, type, userIds],
  );
  return new Map(
    r.rows.map((row) => [
      row.user_id,
      { campana: row.campana, correo: row.correo, push: row.push },
    ]),
  );
}

/**
 * Transportes que el worker puede prestarle a los avisos (#78). Van por
 * fuera del módulo a propósito: notifications no importa whatsapp ni sabe
 * de VAPID, y si no se los pasan, degrada y el aviso igual queda en la
 * campana.
 */
export interface Transportes {
  push?: PushSender | null;
  whatsappEquipo?: EnvioEquipo | null;
}

export async function handleNotifiableEvent(
  event: EventEnvelope,
  client: PoolClient,
  transportes: Transportes = {},
): Promise<void> {
  const aviso = await avisoDe(event, client);
  if (!aviso || aviso.recipients.length === 0) return;
  const prefs = await preferenciasDe(client, event.tenantId, aviso.recipients, aviso.type);
  const critica = TIPOS_CRITICOS.has(aviso.type);
  const adminIds = critica ? new Set(await admins(client, event.tenantId)) : new Set<string>();

  for (const userId of new Set(aviso.recipients)) {
    const pref = prefs.get(userId) ?? { campana: true, correo: true, push: true };
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
    if (pref.push) {
      // Mejor-esfuerzo, igual que el correo: un push que no sale no puede
      // reintentar el evento entero ni tumbar el resto de los avisos.
      await sendPushToUser(client, {
        tenantId: event.tenantId,
        userId,
        payload: { title: aviso.title, body: aviso.body, link: aviso.link, tag: aviso.type },
        sender: transportes.push ?? null,
      }).catch(() => {});
    }
  }

  // WhatsApp al equipo: solo críticos, solo quien dio opt-in (#78).
  await dispatchTeamWhatsApp(client, {
    tenantId: event.tenantId,
    type: aviso.type,
    userIds: [...new Set(aviso.recipients)],
    title: aviso.title,
    body: aviso.body,
    enviar: transportes.whatsappEquipo ?? null,
  }).catch(() => []);
}

/** Los eventos que este módulo escucha. Exportado para el test que lo
 *  compara contra el manifiesto: el catálogo sale de ahí. */
export const EVENTOS = [
  'payment.received',
  'conversation.unattended',
  'sla.first_response_breached',
  'note.mentioned',
  'activity.due',
  'agent.quota_threshold',
  'number.quality_changed',
  // El estado de la cuenta (issue 273): se publicaba y no lo oía nadie.
  'tenant.state_changed',
  // El aviso antes del borrado (#218): 15 días para exportar o volver.
  'tenant.deletion_warned',
] as const;

/**
 * Para registrar en el despachador de workers. Los transportes se pasan
 * acá: el worker sabe de VAPID y del canal de WhatsApp; el módulo, no.
 */
export function notificationConsumers(transportes: Transportes = {}): Consumer[] {
  return EVENTOS.map((event) => ({
    name: `notifications.${event}`,
    moduleId: 'notifications',
    event,
    handler: (evento: EventEnvelope, client: PoolClient) =>
      handleNotifiableEvent(evento, client, transportes),
  }));
}
