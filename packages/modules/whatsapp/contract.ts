// Única puerta pública del módulo whatsapp (SPEC §26).
export const MODULE_ID = 'whatsapp' as const;
export {
  ZAVU_API_BASE_DEFAULT,
  createZavuProvider,
  verifyZavuSignature,
  fetchMediaBytes,
  normalizeStatuses,
  referralDe,
} from './application/zavu';
export type { DeliveryStatusUpdate } from './application/zavu';
export {
  deliverOutbound,
  checkNumberRateLimit,
  causaLegible,
  RateLimitedError,
  CAUSAS_META,
} from './application/outbound';
export type { OutboundJobData } from './application/outbound';
export type { ZavuConfig } from './application/zavu';
export {
  connectWhatsAppNumber,
  listWhatsAppNumbers,
  findNumberBySenderId,
} from './application/numbers';
export type { WhatsAppNumber } from './application/numbers';
export { downloadAttachmentsToR2 } from './application/media';
export type { AdjuntoEntrante, AdjuntoGuardado } from './application/media';
export {
  applyQualityUpdate,
  normalizeQualityUpdates,
  isBusinessPaused,
  numeroEnRojo,
  resumeBusinessSends,
} from './application/quality';
export type { NumberQuality, QualityUpdate } from './application/quality';
export {
  clienteZavu,
  elegirSender,
  quienSoy,
  llaveSirveParaAmbiente,
  conectarSender,
  urlWebhook,
  EVENTOS_WEBHOOK,
} from './application/conectar';
export type { SenderZavu, LlamarZavu, ResultadoConexion, ProyectoZavu } from './application/conectar';
export {
  listTemplates,
  createTemplate,
  updateTemplate,
  getTemplate,
  marcarEnviadaARevision,
  aplicarEstadoDelProveedor,
  prepararEnvio,
  enviarPlantilla,
} from './application/plantillas';
export type { Plantilla } from './application/plantillas';
export {
  CATEGORIAS,
  ESTADOS_PLANTILLA,
  validarPlantilla,
  renderizar,
  normalizarNombre,
  variablesDe,
  puedeEnviarse,
} from './domain/plantillas';
export type { CategoriaPlantilla, EstadoPlantilla, PlantillaBorrador } from './domain/plantillas';
