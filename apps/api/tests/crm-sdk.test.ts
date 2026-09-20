import { afterAll, beforeAll, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/main';
import { crmRoutes } from '../../../packages/sdk/src/crm-routes.generated';

let app: INestApplication;
let document: { paths: Record<string, Record<string, { operationId: string; parameters?: Array<{ name: string }> }>> };
beforeAll(async () => {
  app = await createApp(); await app.listen(0);
  document = await (await fetch(`${await app.getUrl()}/docs-json`)).json();
});
afterAll(async () => { await app.close(); });

for (const [id, route] of Object.entries(crmRoutes)) {
  it(`SDK: ${id} coincide con OpenAPI`, () => {
    expect(document.paths[route.path]?.[route.method.toLowerCase()]?.operationId).toBe(id);
  });
}
it('OpenAPI publica los parámetros de orden, filtro y cursor', () => {
  for (const path of ['/v1/contacts', '/v1/deals']) {
    const names = document.paths[path].get.parameters?.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(['sort', 'order', 'cursor', 'limit']));
  }
});
