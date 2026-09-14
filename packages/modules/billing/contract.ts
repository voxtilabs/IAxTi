// Única puerta pública del módulo billing (SPEC §26).
export const MODULE_ID = 'billing' as const;
export {
  ensureSubscription,
  getSubscription,
  listInvoices,
  issueInvoiceForCycle,
  billingConsumers,
  sweepBilling,
} from './application/billing';
export type { Subscription, Invoice } from './application/billing';
export { planPricing, buildInvoiceLines, invoiceTotal, usdClpRate } from './domain/pricing';
export type { PlanPricing, InvoiceLine } from './domain/pricing';
