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
  setChannelState,
  listChannelAccounts,
} from './application/accounts';
export { simuladorProvider, firmarWebhook } from './application/simulador';
