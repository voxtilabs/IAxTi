// Única puerta pública del módulo webchat (SPEC §26).
export const MODULE_ID = 'webchat' as const;
export {
  webchatProvider,
  createWidget,
  listWidgets,
  setWidgetActive,
  findWidgetById,
  domainAllowed,
  startSession,
  getSession,
  postVisitorMessage,
  getSessionReplies,
} from './application/webchat';
export type { Widget, Session, VisitorMessageResult } from './application/webchat';
