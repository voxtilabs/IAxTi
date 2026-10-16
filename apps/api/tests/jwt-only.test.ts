import { expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ModuleRegistry } from '@iaxti/core';
import { AuthzGuard, type AuthzOptions, type WithUser } from '../src/authz/authz.guard';
import { RequireAuth, RequireModule, RequirePermission } from '../src/authz/decorators';

class Routes {
  @RequireModule('calendar')
  @RequireAuth({ jwtOnly: true })
  @RequirePermission('calendar.read')
  protected() {}

  @RequireModule('calendar')
  @RequireAuth({ jwtOnly: true })
  session() {}

  @RequireModule('platform')
  @RequireAuth({ jwtOnly: true })
  @RequirePermission('platform.tenants')
  platform() {}
}
function fixture(headers: Record<string, string>, options: AuthzOptions, method: 'protected' | 'session' | 'platform' = 'protected') {
  const registry = new ModuleRegistry().load();
  const request = { method: 'GET', path: '/test', requestId: 'test', headers } as WithUser;
  const context = {
    getHandler: () => Routes.prototype[method], getClass: () => Routes,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { guard: new AuthzGuard(new Reflector(), registry, options), context, request, registry };
}
it('JWT-only no permite fallback de desarrollo, solo o combinado con permiso', async () => {
  for (const method of ['protected', 'session'] as const) {
    const fixture0 = fixture({ 'x-user-id': 'fake', 'x-tenant-id': 'tenant', 'x-role': 'ADMIN', authorization: 'Bearer no-verificado' }, { jwtVerify: null }, method);
    await expect(fixture0.guard.canActivate(fixture0.context)).rejects.toMatchObject({ status: 401 });
  }
});
it('API keys válidas con scopes no sustituyen un JWT humano', async () => {
  const resolveApiKey = vi.fn(async () => ({ id: 'key', tenantId: 'tenant', scopes: ['calendar.read'] }));
  const attempts: Record<string, string>[] = [{ 'x-api-key': 'iaxti_valid' }, { authorization: 'Bearer iaxti_valid' }];
  for (const headers of attempts) {
    const fixture0 = fixture(headers, { resolveApiKey, jwtVerify: async () => { throw new Error('No JWT'); } });
    await expect(fixture0.guard.canActivate(fixture0.context)).rejects.toMatchObject({ status: 401 });
  }
  expect(resolveApiKey).not.toHaveBeenCalled();
});
it('JWT humano aún exige membresía y permiso y deriva actor desde la sesión', async () => {
  const resolveRole = vi.fn(async () => 'ADMIN');
  const fixture0 = fixture({ authorization: 'Bearer valid', 'x-user-id': 'fake', 'x-role': 'USER', 'x-tenant-id': 'tenant' }, {
    jwtVerify: async () => ({ userId: 'actual' }), resolveRole,
  });
  expect(await fixture0.guard.canActivate(fixture0.context)).toBe(true);
  expect(resolveRole).toHaveBeenCalledWith('tenant', 'actual');
  expect(fixture0.request.actor).toMatchObject({ userId: 'actual', role: 'ADMIN', tenantId: 'tenant' });
  const denied = fixture({ authorization: 'Bearer valid', 'x-tenant-id': 'other' }, { jwtVerify: async () => ({ userId: 'actual' }), resolveRole: async () => null });
  await expect(denied.guard.canActivate(denied.context)).rejects.toMatchObject({ status: 403 });
});
it('el módulo apagado tampoco queda accesible por la puerta de solo sesión', async () => {
  const fixture0 = fixture({ authorization: 'Bearer valid' }, { jwtVerify: async () => ({ userId: 'actual' }) }, 'session');
  fixture0.registry.disable('calendar');
  await expect(fixture0.guard.canActivate(fixture0.context)).rejects.toMatchObject({ status: 403 });
});

it('JWT-only también excluye identidad y rol de desarrollo con permisos de plataforma', async () => {
  const headers = { 'x-user-id': 'fake', 'x-role': 'SUPERADMIN', authorization: 'Bearer valid' };
  const unverified = fixture(headers, { jwtVerify: null }, 'platform');
  await expect(unverified.guard.canActivate(unverified.context)).rejects.toMatchObject({ status: 401 });
  const noRole = fixture(headers, { jwtVerify: async () => ({ userId: 'actual' }) }, 'platform');
  await expect(noRole.guard.canActivate(noRole.context)).rejects.toMatchObject({ status: 403 });
  const verified = fixture(headers, {
    jwtVerify: async () => ({ userId: 'actual' }), resolvePlatformAdmin: async (userId) => userId === 'actual',
  }, 'platform');
  expect(await verified.guard.canActivate(verified.context)).toBe(true);
});
