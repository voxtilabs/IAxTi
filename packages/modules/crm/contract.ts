// Única puerta pública del módulo crm (SPEC §26).
export const MODULE_ID = 'crm' as const;
export {
  createContact,
  ensureContactByPhone,
  updateContact,
  registerOptIn,
  optOut,
  handleInboundForConsent,
  canReceiveBusinessInitiated,
} from './application/contacts';
export type { Contact, ContactOrigin, CreateContactInput } from './application/contacts';
export { normalizePhone, normalizeRut, isOptOutMessage } from './domain/validation';
