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
export { driveDesdeEntorno } from './application/drive-config';
export type { DriveDeps } from './application/drive-config';
export { driveAudit, estadoDrive,iniciarDrive,completarDrive,revocarDrive,prepararPickerDrive,seleccionarArchivoDrive,permitirIaDrive,buscarDrive,adjuntarDrive,adjuntosDrive } from './application/drive';
export type { PersonalDriveFile } from './application/drive';
export type { DriveContext } from './application/drive-access';
export { configurarCarpetaDrive,estadoCarpetaDrive,driveConsumers,guardarAdjuntosDrive } from './application/drive-uploads';
export type { DriveAttachmentStorage } from './application/drive-uploads';
