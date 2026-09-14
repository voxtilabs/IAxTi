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
export { renderEmail, resolveUserEmail, sendNotificationEmail, resetSmtp } from './application/email';
