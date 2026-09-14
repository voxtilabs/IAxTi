// Única puerta pública del módulo conversations (SPEC §26).
export const MODULE_ID = 'conversations' as const;
export {
  receiveInbound,
  sendMessage,
  updateDeliveryStatus,
  updateDeliveryStatusByProviderId,
  getOutboundContext,
  assignConversation,
  changeConversationState,
  getConversation,
  listMessages,
} from './application/conversations';
export type {
  Conversation,
  Message,
  Channel,
  MessageType,
  AuthorKind,
  InboundInput,
  InboundResult,
  SendMessageInput,
} from './application/conversations';
export { listInbox, getConversationDetail } from './application/inbox';
export { autoAssignNew } from './application/assignment';
export {
  createQuickReply,
  listQuickReplies,
  deleteQuickReply,
  addInternalNote,
  listInternalNotes,
  searchConversations,
} from './application/equipo';
export type { QuickReply, InternalNote, SearchHit } from './application/equipo';
export { renderQuickReply, quickReplyVariables, extractMentions } from './domain/plantillas';
export { checkConversationAlerts } from './application/sla';
export {
  bandejaSettings,
  minutosHabilesEntre,
  enSilencio,
  msHastaFinDeSilencio,
  DEFAULT_HORARIO,
  DEFAULT_SILENCIO,
} from './domain/horario';
export type { AssignmentMode, BandejaSettings, BusinessHours, QuietHours } from './domain/horario';
export type { InboxItem, InboxFilters, ConversationDetail } from './application/inbox';
export {
  assertConversationTransition,
  assertDeliveryAdvance,
  isWithin24hWindow,
  CONVERSATION_STATES,
} from './domain/state';
export type { ConversationState, DeliveryStatus } from './domain/state';
export { autoResolveTenant, archiveTenant } from './application/cierre';
export type { RunResult } from './application/cierre';
export { cierreSettings } from './domain/cierre';
export type { CierreSettings } from './domain/cierre';
export { onContactMerged } from './application/merge-consumer';
