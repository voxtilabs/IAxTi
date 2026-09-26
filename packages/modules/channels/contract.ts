// Única puerta pública del módulo channels (SPEC §26).
export const MODULE_ID = 'channels' as const;
export {
  CHANNEL_KINDS,
  CHANNEL_STATES,
  assertChannelTransition,
  registerProvider,
  getProvider,
  resetProviders,
} from './domain/port';
export type {
  ChannelKind,
  ChannelState,
  ChannelProvider,
  ChannelAccountRef,
  OutboundMessage,
  NormalizedInbound,
  PuertoDePlantillas,
  PlantillaDelProveedor,
} from './domain/port';
export {
  createChannelAccount,
  getChannelAccount,
  findAccountById,
  tenantDeCuenta,
  setChannelState,
  listChannelAccounts,
} from './application/accounts';
export { simuladorProvider, firmarWebhook } from './application/simulador';
// El rastro de los webhooks y por qué no llegan los mensajes (#434).
export { anotarWebhook, rastroDeWebhook } from './application/rastro';
export type { ResultadoDeWebhook, RastroDeWebhook } from './application/rastro';
export { diagnosticarCanal } from './application/diagnostico';
export type { Diagnostico, PasoDelDiagnostico, EstadoDelPaso } from './application/diagnostico';

// Los límites de un adjunto (#560): los declara el canal, y salen por acá para
// que la API y la interfaz usen la misma tabla y el mismo mensaje.
export {
  LIMITES_WHATSAPP,
  LIMITES_CONSERVADORES,
  limitesDelCanal,
  claseDeAdjunto,
  revisarAdjunto,
} from './domain/adjuntos';
export type { ClaseDeAdjunto, LimiteDeAdjunto, RevisionDeAdjunto } from './domain/adjuntos';
