import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/main';
import { campaignRoutes } from '../../../packages/sdk/src/campaign-routes.generated';

let app: INestApplication;
let paths: Record<string, Record<string, { operationId: string }>>;
beforeAll(async () => {
  app = await createApp();
  await app.listen(0);
  paths = (await (await fetch(`${await app.getUrl()}/docs-json`)).json()).paths;
});
afterAll(async () => { await app.close(); });

describe('SDK de campañas contra el OpenAPI real (#348)', () => {
  for (const [id, route] of Object.entries(campaignRoutes)) {
    it(id, () => {
      expect(paths[route.path]?.[route.method.toLowerCase()]?.operationId).toBe(id);
    });
  }
});
