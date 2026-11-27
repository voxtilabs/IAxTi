// Única puerta pública del módulo whatsapp (SPEC §26).
export const MODULE_ID = 'whatsapp' as const;
// Zernio (#1317, ADR-0032): el adaptador de WhatsApp que queda. `baseDeZernio`
// lo usa el worker de entrada para que la llave de una cuenta de Zernio pueda
// ir a SU dominio al bajar adjuntos (#1335).
export { createZernioProvider, entrantesSinTelefono } from './application/zernio';
export { baseDeZernio, ErrorDeZernio } from './application/zernio-base';
export { llamarAZernio } from './application/zernio-base';
export type { ConfigDeZernio } from './application/zernio-base';
export {
  deliverOutbound,
  checkNumberRateLimit,
  causaLegible,
  RateLimitedError,
  ErrorPermanente,
  codigoDelProveedor,
  esPermanente,
  rechazoPermanente,
  MOTIVO_TOPE_DIARIO,
  mensajeDeRechazo,
  CAUSAS_META,
} from './application/outbound';
export type { OutboundJobData } from './application/outbound';
export {
  connectWhatsAppNumber,
  desconectarNumero,
  listWhatsAppNumbers,
  findNumberBySenderId,
} from './application/numbers';
export type { WhatsAppNumber } from './application/numbers';
export { fetchMediaBytes, downloadAttachmentsToR2 } from './application/media';
export type { AdjuntoEntrante, AdjuntoGuardado, ConfigDeMedia } from './application/media';
export {
  applyQualityUpdate,
  isBusinessPaused,
  numeroEnRojo,
  resumeBusinessSends,
} from './application/quality';
export type { NumberQuality, QualityUpdate } from './application/quality';
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
  validarPlantilla,
  renderizar,
  normalizarNombre,
  variablesDe,
  puedeEnviarse,
} from './domain/plantillas';
export type { CategoriaPlantilla, EstadoPlantilla, PlantillaBorrador } from './domain/plantillas';
export {
  resolveChannelWebhookSecret,
  credencialDeLaCuenta,
  hayCredencialDeLaCuenta,
  secretStoreDelCanal,
} from './application/webhook-secret';
// Un perfil de Zernio por tenant y la verificación por mensaje (#1321).
export {
  eventoDeZernioEsDeLaCuenta,
  perfilDelTenant,
  cuentaDelPerfil,
  listarCuentasDelPerfil,
  cuentaEnZernio,
  llaveDelTenant,
  suscribirWebhook,
  enlaceParaConectar,
  darDeAltaCuentaDeZernio,
  cuentaDeZernioYaConectada,
  asegurarAdaptadorDeZernio,
  ErrorDelAlta,
} from './application/zernio-perfil';
export type { VeredictoDelEvento, PerfilDeZernio } from './application/zernio-perfil';
export {
  enlaceParaConectarDesdeLaApp,
  numerosParaConectar,
  conectarNumeroDesdeLaApp,
  type DependenciasDelAlta,
  type NumeroParaConectar,
} from './application/conectar-desde-la-app';
// Aprender de los chats del negocio (#1406, ADR-0039): autorizar y retirar
// la lectura del historial, y el estado para la pantalla.
export {
  ErrorDeHistorial,
  autorizarAprendizajeDeChats,
  retirarAutorizacionDeChats,
  estadoDelHistorial,
} from './application/aprender-de-chats';
export type { EstadoDelHistorial, EstadoDeMeta } from './application/aprender-de-chats';
