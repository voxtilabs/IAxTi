export const packageName = '@iaxti/sdk';
export { crmClient } from './crm';

export * from './onboarding';
export * from './campaigns';
// Quién hizo algo (#697): el servidor manda un nombre, no un UUID.
export type { Quien } from './quien';
