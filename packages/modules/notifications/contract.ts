// Única puerta pública del módulo notifications (SPEC §26).
export const MODULE_ID = 'notifications' as const;
export {
  NOTIFICATION_TYPES,
  TIPOS_CRITICOS,
  TIPOS_LEGIBLES,
  notifyUser,
  listNotifications,
  markRead,
  getPreferences,
  setPreference,
} from './application/notifications';
export type { Notification, NotificationType, Preference } from './application/notifications';
export { notificationConsumers, handleNotifiableEvent } from './application/consumers';
export type { Transportes } from './application/consumers';
export { renderEmail, resolveUserEmail, sendNotificationEmail, resetSmtp } from './application/email';
export {
  registerPushSubscription,
  deletePushSubscription,
  listPushSubscriptions,
  sendPushToUser,
  vapidFromEnv,
} from './application/push';
export type { PushSubscription, PushPayload, PushSender, ResultadoPush, VapidConfig } from './application/push';
export { teamWhatsAppTargets, dispatchTeamWhatsApp } from './application/equipo-whatsapp';
export type { DestinatarioEquipo, EnvioEquipo, ResultadoEquipo } from './application/equipo-whatsapp';
