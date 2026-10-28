// Única puerta pública del módulo billing (SPEC §26).
export const MODULE_ID = 'billing' as const;
export {
  ensureSubscription,
  getSubscription,
  listInvoices,
  costosDelCicloEnCurso,
  metaCostThisCycle,
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
/**
 * Del dólar (#796) se publica SOLO lo que alguien abre hoy: el worker llama a
 * `sincronizarCambio` y nada más.
 *
 * Lo demás —`aPesos`, `cambiosDelRango`, `cambioDelDia`, `PAR`…— queda interno
 * hasta que la conversión en las pantallas lo necesite, y la guarda de #664 lo
 * exigió así cuando intenté publicarlo entero: «un contrato que expone lo que
 * nadie abre deja de ser una decisión». Tenía razón: ocho nombres publicados
 * por si acaso son ocho formas de que alguien entre por la puerta equivocada
 * antes de que exista la correcta.
 */
export { sincronizarCambio } from './application/cambio';
