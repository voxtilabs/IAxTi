import { afterAll, beforeAll, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/main';
import { onboardingOperation } from '../../../packages/sdk/src/onboarding-route.generated';

let app: INestApplication;
beforeAll(async () => { app = await createApp(); await app.listen(0); });
afterAll(async () => { await app.close(); });

it('la ruta de avance del SDK coincide con el OpenAPI real', async () => {
  const { paths } = await (await fetch(`${await app.getUrl()}/docs-json`)).json();
  expect(paths[onboardingOperation.path]?.[onboardingOperation.method.toLowerCase()]?.operationId)
    .toBe('OnboardingController_estado');
});
