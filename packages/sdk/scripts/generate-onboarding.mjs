import { readFileSync, writeFileSync } from 'node:fs';
const document = JSON.parse(readFileSync(process.argv[2], 'utf8'));
let route;
for (const [path, methods] of Object.entries(document.paths)) {
  for (const [method, operation] of Object.entries(methods)) {
    if (operation.operationId === 'OnboardingController_estado') route = { method: method.toUpperCase(), path };
  }
}
if (!route) throw new Error('El OpenAPI no contiene OnboardingController_estado.');
writeFileSync(new URL('../src/onboarding-route.generated.ts', import.meta.url),
  '// Generado desde OpenAPI por scripts/generate-onboarding.mjs.\n' +
  `export const onboardingOperation = ${JSON.stringify(route)} as const;\n`);
