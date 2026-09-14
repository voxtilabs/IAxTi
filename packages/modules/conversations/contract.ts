// Única puerta pública del módulo conversations (SPEC §26).
export const MODULE_ID = 'conversations' as const;
export {
  receiveInbound,
  sendMessage,
  updateDeliveryStatus,
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
export type { InboxItem, InboxFilters, ConversationDetail } from './application/inbox';
export {
  assertConversationTransition,
  assertDeliveryAdvance,
  isWithin24hWindow,
  CONVERSATION_STATES,
} from './domain/state';
export type { ConversationState, DeliveryStatus } from './domain/state';
