// Única puerta pública del módulo payments (SPEC §26).
export const MODULE_ID = 'payments' as const;
export {
  addProvider,
  listProviders,
  getProviderById,
  createPaymentLink,
  markLinkSent,
  listLinks,
  cancelLink,
  expireLinks,
  tenantsWithExpirableLinks,
  findProviderGlobal,
  tenantDeProveedor,
} from './application/links';
export type { PaymentProvider, PaymentLink } from './application/links';
export { confirmPayment } from './application/confirm';
export type { DepsConfirmacion } from './application/confirm';
export type { ConfirmInput, ConfirmResult } from './application/confirm';
export {
  createFlowProvider,
  createSimuladoProvider,
  paymentProviderFor,
  registerPaymentProvider,
  flowSign,
} from './domain/providers';
export type {
  PaymentProviderPort,
  ProviderKind,
  WebhookPayment,
  CreatedLink,
} from './domain/providers';

export { flowConfig } from './domain/flow-config';
