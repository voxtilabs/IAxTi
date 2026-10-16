export const packageName = '@iaxti/sdk';
export { crmClient } from './crm';

export * from './onboarding';
export * from './registration';
export * from './campaigns';
// Quién hizo algo (#697): el servidor manda un nombre, no un UUID.
export type { Quien } from './quien';
export * from './google-calendar';
export { partnerClient } from './partner';
export type { PartnerInvitationState } from './partner';
