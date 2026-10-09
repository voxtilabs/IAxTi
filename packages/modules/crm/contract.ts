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
  getContactEmail,
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
  ActivityReferenceError,
  createActivity,
  completeActivity,
  listActivities,
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
export { listContacts, ensureWebContact, contactoPorTelefono } from './application/contacts';
export { mergeContacts, previewImport, confirmImport } from './application/merge';
export type { ImportPreview, ImportRowResult } from './application/merge';
export { parseCsv, guessMapping, sniffDelimiter, IMPORT_FIELDS } from './domain/csv';
export type { ImportField } from './domain/csv';
export { exportarTitular, suprimirTitular } from './application/titular';
export type { ExportacionTitular, ResultadoSupresion } from './application/titular';
export {
  listCustomFields,
  createCustomField,
  deleteCustomField,
  validarCustom,
  paraLaIa,
  llaveDeCampo,
  TIPOS_DE_CAMPO,
  ENTIDADES_CON_CAMPOS,
} from './application/campos';
export type { CampoPersonalizado, TipoDeCampo, EntidadConCampos } from './application/campos';
export {
  listTags,
  createTag,
  updateTag,
  deleteTag,
  contactTags,
  setContactTags,
  ROLES_DE_ETIQUETA,
} from './application/tags';
export type { Etiqueta, RolDeEtiqueta } from './application/tags';
export { exportarContactos } from './application/exportar-contactos';
export type { ExportacionContactos } from './application/exportar-contactos';
export {
  renamePipeline,
  updateStage,
  addStage,
  reorderStages,
  deleteStage,
} from './application/pipelines';
export type { EtapaEditada } from './application/pipelines';
export {
  listCompanies,
  getCompany,
  createCompany,
  updateCompany,
  archiveCompany,
  asignarEmpresa,
  companyContacts,
} from './application/empresas';
export type { Empresa } from './application/empresas';

// El embudo que se puede leer (#695): won_at, lost_at y la historia de etapas
// se escribían desde el día uno y ningún SELECT las devolvía.
export { getEmbudo, historiaDeEtapas, RangoInvalido } from './application/embudo';
export type { Embudo, EmbudoInput, EtapaDelEmbudo, PasoDeEtapa } from './application/embudo';

export { InvalidListQuery } from './application/list-cursor';
export { addTagToContacts } from './application/tags';
