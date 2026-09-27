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

/**
 * El fallback por cabeceras no existe donde hay tokens (#611).
 *
 * Decía «se retira en hardening» y no se retiró. Lo comprobé CONTRA STAGING, en
 * vivo: sin ningún token, mandando solo
 *
 *     X-User-Id: <cualquiera>   X-Tenant-Id: <uuid de un negocio>   X-Role: ADMIN
 *
 * la API contestaba 200. Cualquiera que supiera un uuid de tenant era ADMIN de
 * ese negocio: leer sus conversaciones, escribirle a sus clientes desde su
 * número, crear links de cobro. Y staging está conectado al número real de
 * VoxTi, así que no era un riesgo teórico.
 *
 * Dos cerraduras, porque una sola se abre por olvido:
 *  1. Si el servidor PUEDE verificar tokens, este camino no existe. Es la regla
 *     de fondo y no depende de configuración.
 *  2. Y si por error faltara `SUPABASE_JWKS_URL` en staging o producción —lo que
 *     abriría la cerradura 1 sola—, el ambiente lo impide igual.
 */
describe('el fallback por cabeceras no existe donde hay tokens (#611)', () => {
  const HEADERS_FALSOS = {
    'X-User-Id': '11111111-1111-4111-8111-111111111111',
    'X-Tenant-Id': '22222222-2222-4222-8222-222222222222',
    'X-Role': 'ADMIN',
  };

  it('con verificador de JWT configurado, las cabeceras NO entran', async () => {
    // Es el caso de staging y de producción: hay jwtVerify, así que mandar
    // cabeceras tiene que dar 401 y no una sesión de ADMIN.
    const app = await createApp({
      jwtVerify: async () => ({ userId: 'no-deberia-usarse' }),
      resolveRole: async () => 'ADMIN',
    });
    await app.listen(0);
    try {
      const r = await fetch(`${await app.getUrl()}/v1/me`, { headers: HEADERS_FALSOS });
      expect(r.status, 'sin token, las cabeceras no pueden dar acceso').toBe(401);
      expect((await r.json()).code).toBe('UNAUTHORIZED');
    } finally {
      await app.close();
    }
  });

  it('sin verificador pero en un ambiente de verdad, tampoco', async () => {
    // La segunda cerradura: si faltara SUPABASE_JWKS_URL por error de
    // configuración, la primera se abriría sola. Esta no.
    const antes = process.env.IAXTI_ENV;
    process.env.IAXTI_ENV = 'staging';
    const app = await createApp({ jwtVerify: null, resolveRole: async () => 'ADMIN' });
    await app.listen(0);
    try {
      const r = await fetch(`${await app.getUrl()}/v1/me`, { headers: HEADERS_FALSOS });
      expect(r.status).toBe(401);
    } finally {
      await app.close();
      if (antes === undefined) delete process.env.IAXTI_ENV;
      else process.env.IAXTI_ENV = antes;
    }
  });

  it('en desarrollo local sin verificador, sigue sirviendo', async () => {
    // El fallback existe para trabajar sin Supabase cableado. Cerrarlo del todo
    // rompería eso, y entonces alguien lo reabriría de la peor forma posible.
    const antes = process.env.IAXTI_ENV;
    delete process.env.IAXTI_ENV;
    const app = await createApp({ jwtVerify: null, resolveRole: async () => 'ADMIN' });
    await app.listen(0);
    try {
      const r = await fetch(`${await app.getUrl()}/v1/me`, { headers: HEADERS_FALSOS });
      expect(r.status, 'en local sin Supabase el fallback tiene que funcionar').toBe(200);
    } finally {
      await app.close();
      if (antes !== undefined) process.env.IAXTI_ENV = antes;
    }
  });
});
