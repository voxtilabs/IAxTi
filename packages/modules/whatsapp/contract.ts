// Única puerta pública del módulo whatsapp (SPEC §26).
export const MODULE_ID = 'whatsapp' as const;
export { createKapsoProvider, fetchMediaBytes } from './application/kapso';
export type { KapsoConfig } from './application/kapso';
export {
  connectWhatsAppNumber,
  listWhatsAppNumbers,
  findNumberByPhoneNumberId,
} from './application/numbers';
export type { WhatsAppNumber } from './application/numbers';
export { downloadAttachmentsToR2 } from './application/media';
export type { AdjuntoEntrante, AdjuntoGuardado } from './application/media';
