// Única puerta pública del módulo crm (SPEC §26).
export const MODULE_ID = 'crm' as const;
export {
  createContact,
  ensureContactByPhone,
  ensureContactByIdentity,
  identityFor,
  linkIdentity,
  updateContact,
  registerOptIn,
  optOut,
  handleInboundForConsent,
  canReceiveBusinessInitiated,
  ORIGENES_DE_CANAL,
} from './application/contacts';
export type { IdentityChannel } from './application/contacts';
export type { Contact, ContactOrigin, CreateContactInput } from './application/contacts';
export { normalizePhone, normalizeRut, isOptOutMessage } from './domain/validation';
export {
  createPipeline,
  getPipelineStages,
  ensureDefaultLossReasons,
  listLossReasons,
  createDeal,
  moveDealStage,
  updateDeal,
  markStalledDeals,
  listStalledDeals,
  DEFAULT_LOSS_REASONS,
} from './application/deals';
export type {
  Pipeline,
  Stage,
  Deal,
  DealCurrency,
  CreateDealInput,
  MoveDealInput,
} from './application/deals';
export type { StageInput, StageType } from './domain/pipeline';
export {
  createActivity,
  completeActivity,
  listActivitiesByContact,
  markDueActivities,
  getContactFicha,
} from './application/activities';
export type { Activity, ActivityType } from './application/activities';
export {
  listDeals,
  listPipelines,
  listSavedFilters,
  saveFilter,
  deleteSavedFilter,
} from './application/board';
export type { DealCard, DealFilters, SavedFilter } from './application/board';
export { listContacts, ensureWebContact } from './application/contacts';
export { mergeContacts, previewImport, confirmImport } from './application/merge';
export type { ImportPreview, ImportRowResult } from './application/merge';
export { parseCsv, guessMapping, sniffDelimiter, IMPORT_FIELDS } from './domain/csv';
export type { ImportField } from './domain/csv';
export { exportarTitular, suprimirTitular } from './application/titular';
export type { ExportacionTitular, ResultadoSupresion } from './application/titular';
