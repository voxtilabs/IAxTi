import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ModuleRegistry } from '@iaxti/core';
import { createApp } from '../src/main';
import { AuthzGuard } from '../src/authz/authz.guard';
import { RequireModule, RequirePermission } from '../src/authz/decorators';

/**
 * Los directorios temporales se borran al terminar.
 *
 * Sin esto cada corrida deja uno —esta prueba, varios— y el tmpfs se llena: llegué
 * a 2168 directorios `iaxti-*` y más de 600 MB, y lo que rompió no fue una prueba
 * sino la máquina, a mitad de otra cosa. Una prueba que deja basura es una prueba
 * que a la larga hace fallar a las demás, y el fallo aparece lejísimos de acá.
 */
const temporales: string[] = [];
function registrarTemporal(dir: string): string {
  temporales.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of temporales) rmSync(dir, { recursive: true, force: true });
});


let app: INestApplication;
let base: string;

beforeAll(async () => {
  app = await createApp();
  await app.listen(0);
  base = await app.getUrl();
});

afterAll(async () => {
  await app.close();
});

const url = () => `${base}/v1/demo/protegido`;
const identidad = (role: string) => ({
  'X-User-Id': 'u-1',
  'X-Tenant-Id': 't-1',
  'X-Role': role,
});

describe('guard de autorización (e2e)', () => {
  it('sin identidad responde 401 en formato único', async () => {
    const res = await fetch(url());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe('UNAUTHORIZED');
    expect(body.requestId).toMatch(/^req_/);
  });

  it('USER no tiene audit.read: 403 PERMISSION_DENIED', async () => {
    const res = await fetch(url(), { headers: identidad('USER') });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('PERMISSION_DENIED');
    expect(body.message).toMatch(/Tu rol no permite/);
  });

  it('ADMIN y SUPERVISOR sí tienen audit.read', async () => {
    for (const role of ['ADMIN', 'SUPERVISOR']) {
      const res = await fetch(url(), { headers: identidad(role) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    }
  });

  it('un rol desconocido (custom, llega en #73) no concede nada', async () => {
    const res = await fetch(url(), { headers: identidad('CONTADOR') });
    expect(res.status).toBe(403);
  });
});

describe('guard de autorización (unidad, módulo apagado)', () => {
  function fixtureRegistry(): ModuleRegistry {
    const dir = registrarTemporal(mkdtempSync(join(tmpdir(), 'iaxti-authz-')));
    const mods: Record<string, string> = {
      identity: `module: { id: identity, version: 0.1.0, core: true }\n`,
      organizations: `module: { id: organizations, version: 0.1.0, core: true }\ndepends_on: { required: [identity] }\n`,
      authorization: `module: { id: authorization, version: 0.1.0, core: true }\ndepends_on: { required: [identity, organizations] }\n`,
      audit: `module: { id: audit, version: 0.1.0, core: true }\ndepends_on: { required: [identity, organizations] }\n`,
      calendar: `module: { id: calendar, version: 0.1.0 }\npermissions: [calendar.read]\n`,
    };
    for (const [id, yaml] of Object.entries(mods)) {
      mkdirSync(join(dir, id));
      writeFileSync(join(dir, id, 'module.yaml'), yaml);
    }
    return new ModuleRegistry(dir).load();
  }

  class Endpoint {
    @RequireModule('calendar')
    @RequirePermission('calendar.read')
    handler() {}
  }

  function contexto(): ExecutionContext {
    return {
      getHandler: () => Endpoint.prototype.handler,
      getClass: () => Endpoint,
      switchToHttp: () => ({
        getRequest: () => ({
          requestId: 'req_test',
          headers: { 'x-user-id': 'u', 'x-tenant-id': 't', 'x-role': 'ADMIN' },
        }),
      }),
    } as unknown as ExecutionContext;
  }

  it('módulo apagado responde MODULE_DISABLED aunque el rol tenga el permiso', async () => {
    const registry = fixtureRegistry();
    const guard = new AuthzGuard(new Reflector(), registry);

    await expect(guard.canActivate(contexto())).resolves.toBe(true); // activo: pasa

    registry.disable('calendar');
    try {
      await guard.canActivate(contexto());
      expect.unreachable('debió lanzar');
    } catch (error) {
      const response = (error as { getResponse: () => { code: string } }).getResponse();
      expect(response.code).toBe('MODULE_DISABLED');
    }
  });
});
