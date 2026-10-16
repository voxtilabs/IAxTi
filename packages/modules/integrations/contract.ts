// Única puerta pública del módulo integrations (SPEC §26).
export const MODULE_ID = 'integrations' as const;
export {
  createEndpoint,
  listEndpoints,
  rotateSecret,
  setEndpointActive,
  deleteEndpoint,
  enqueueDeliveries,
  webhookConsumers,
  listDeliveries,
  retryDelivery,
  deliverWebhooks,
} from './application/webhooks';
export type { WebhookEndpoint, Delivery } from './application/webhooks';
export { signPayload, verifySignature, newWebhookSecret, backoffMinutes, MAX_ATTEMPTS } from './domain/signing';

export {estadoGmail,iniciarGmail,completarGmail,revocarGmail,hilosGmail,mantenerGmail,autenticarPushGmail,procesarPushGmail,gmailConsumers,limpiarCacheGmail,limpiarSecretosGmail,GmailAccessError} from './application/gmail';
export type {GmailActor,GmailContext,GmailResult,GmailPush} from './application/gmail';
export {gmailDesdeEntorno} from './application/gmail-config';
export type {GmailDeps} from './application/gmail-config';
