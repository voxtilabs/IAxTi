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
