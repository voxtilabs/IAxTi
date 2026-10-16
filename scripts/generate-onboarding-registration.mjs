import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const document = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const wanted = {
  memberships: 'MeController_me',
  register: 'OnboardingRegistrationController_register',
  business: 'OnboardingRegistrationController_business',
  costs: 'OnboardingRegistrationController_costs',
};
const operations = {};
for (const [key, id] of Object.entries(wanted)) {
  for (const [path, methods] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (operation.operationId === id) operations[key] = { method: method.toUpperCase(), path };
    }
  }
  if (!operations[key]) throw new Error(`Falta la operación ${id} en OpenAPI`);
}
writeFileSync(resolve('packages/sdk/src/registration-routes.generated.ts'),
  '// Generado desde OpenAPI por scripts/generate-onboarding-registration.mjs.\n' +
  `export const registrationRoutes = ${JSON.stringify(operations, null, 2)} as const;\n`);
