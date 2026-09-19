// Única puerta pública del módulo billing (SPEC §26).
export const MODULE_ID = 'billing' as const;
export {
  ensureSubscription,
  getSubscription,
  listInvoices,
  costosDelCicloEnCurso,
  issueInvoiceForCycle,
  billingConsumers,
  sweepBilling,
  cancelarSuscripcion,
} from './application/billing';
export type { Subscription, Invoice } from './application/billing';
export { planPricing, buildInvoiceLines, invoiceTotal, usdClpRate } from './domain/pricing';
export type { PlanPricing, InvoiceLine } from './domain/pricing';
export {
  tenantsPorBorrar,
  avisarBorradoPendiente,
  DIAS_HASTA_AVISAR,
  DIAS_HASTA_BORRAR,
} from './application/fin-de-ciclo';
export type { TenantPorBorrar } from './application/fin-de-ciclo';
export type { CostosDelCiclo } from './application/billing';
