import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { INestApplication, ExecutionContext } from '@nestjs/common';
import type { Pool } from 'pg';
import type { Response } from 'express';
import { of, firstValueFrom } from 'rxjs';
const service = vi.hoisted(() => ({ state: vi.fn(), start: vi.fn(), finish: vi.fn(), revoke: vi.fn(), authenticate: vi.fn() }));
vi.mock('@iaxti/module-calendar', async (original) => ({ ...await original<object>(), estadoGoogleCalendar: service.state,
  iniciarGoogleCalendar: service.start, completarGoogleCalendar: service.finish, revocarGoogleCalendar: service.revoke, autenticarPushGoogle: service.authenticate }));
import { createApp } from '../src/main';
import { registry } from '../src/registry';
import { GOOGLE_CALENDAR_HTTP, GoogleCalendarController, GoogleCalendarWebhookController, type GoogleCalendarHttp } from '../src/google-calendar.controller';
import type { WithRequestId } from '../src/request-id';
import { IdempotenciaInterceptor } from '../src/idempotencia.interceptor';
import { googleRoutes } from '../../../scripts/generate-google-calendar.mjs';
import { googleCalendarRoutes } from '../../../packages/sdk/src/google-calendar-routes.generated';
let app: INestApplication; let base: string; let port: GoogleCalendarHttp; let oldPool: GoogleCalendarHttp['pool']; let oldEnqueue: GoogleCalendarHttp['enqueue'];
const enqueue = vi.fn(async () => {});
const value = { configured: true, status: 'active', calendarId: 'primary', pushActive: false, lastNotificationAt: null };
const challenge = 'a'.repeat(43);
const headers = { Authorization: 'Bearer valid-user', 'X-Tenant-Id': 'tenant-a', 'Content-Type': 'application/json' };
beforeAll(async () => {
  app = await createApp({ jwtVerify: async token => { if (token !== 'valid-user') throw new Error(); return { userId: 'verified-user' }; },
    resolveRole: async tenant => tenant === 'tenant-a' ? 'USER' : tenant === 'tenant-no-permission' ? 'CUSTOM' : null,
    resolveCustomPermissions: async () => [], resolveAccesoModulo: null, resolvePlatformAdmin: null });
  port = app.get<GoogleCalendarHttp>(GOOGLE_CALENDAR_HTTP); oldPool = port.pool; oldEnqueue = port.enqueue;
  port.pool = () => ({} as Pool); port.enqueue = enqueue;
  await app.listen(0); base = await app.getUrl();
});
afterEach(() => { vi.clearAllMocks(); registry.enable('calendar'); });
afterAll(async () => { port.pool = oldPool; port.enqueue = oldEnqueue; await app.close(); });
const post = (path: string, body: unknown, extra: Record<string,string> = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });

describe('Google Calendar HTTP, identidad y contrato', () => {
  it('USER conecta su propia cuenta y cuerpo no puede sustituir actor/tenant', async () => {
    service.start.mockResolvedValue({ state: challenge, nonce: challenge, url: 'https://accounts.google.com/o/oauth2/v2/auth' });
    const response = await post('/v1/agenda/google/iniciar', { challenge }, { 'X-User-Id': 'attacker', 'X-Role': 'ADMIN' });
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(service.start).toHaveBeenCalledWith(expect.anything(), { tenantId: 'tenant-a', userId: 'verified-user', challenge });
    const forged = await post('/v1/agenda/google/iniciar', { challenge, tenantId: 'tenant-b', userId: 'other' });
    expect(forged.status).toBe(400); expect(service.start).toHaveBeenCalledTimes(1);
  });
  it('rechaza fallback, API key, JWT inválido, tenant ajeno y permiso ausente', async () => {
    for (const [extra, status] of [
      [{ Authorization: '', 'X-User-Id': 'fake', 'X-Role': 'ADMIN' },401],
      [{ Authorization: 'Bearer iaxti_key', 'X-Api-Key': 'iaxti_key' },401],
      [{ Authorization: 'Bearer invalid' },401],
      [{ 'X-Tenant-Id': 'tenant-b' },403],
      [{ 'X-Tenant-Id': 'tenant-no-permission' },403],
    ] as Array<[Record<string,string>,number]>) {
      const response = await post('/v1/agenda/google/iniciar', { challenge }, extra);
      expect(response.status).toBe(status); expect(await response.json()).toMatchObject({ code: expect.any(String), requestId: expect.any(String), details: expect.any(Array) });
    }
    expect(service.start).not.toHaveBeenCalled();
  });
  it('completa y revoca solo el usuario verificado; errores externos no salen', async () => {
    service.finish.mockResolvedValue(value);
    expect((await post('/v1/agenda/google/completar', { state: challenge, nonce: challenge, verifier: challenge, code: 'code-test' })).status).toBe(200);
    expect(service.finish).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tenantId: 'tenant-a', userId: 'verified-user' }));
    service.revoke.mockRejectedValue(new Error('PRIVATE-TOKEN-SHOULD-NOT-LEAK'));
    const response = await post('/v1/agenda/google/revocar', {});
    expect(response.status).toBe(400); expect(await response.text()).not.toContain('PRIVATE-TOKEN');
  });
  it('módulo apagado bloquea la conexión', async () => {
    registry.disable('calendar');
    expect((await post('/v1/agenda/google/iniciar', { challenge })).status).toBe(403);
    expect(service.start).not.toHaveBeenCalled();
  });
  it('OpenAPI publica módulo/permisos/sesión y reproduce rutas del SDK', async () => {
    const doc = await (await fetch(`${base}/docs-json`)).json();
    expect(doc.paths['/v1/agenda/google/iniciar'].post).toMatchObject({ 'x-iaxti-module': 'calendar', 'x-iaxti-permission': 'calendar.connect', 'x-iaxti-auth': 'sesion' });
    expect(doc.paths['/v1/agenda/google/iniciar'].post.requestBody.content['application/json'].schema.required).toEqual(['challenge']);
    expect(doc.paths['/v1/agenda/google/completar'].post.requestBody.content['application/json'].schema.required).toEqual(['state', 'nonce', 'verifier', 'code']);
    expect(googleRoutes(doc)).toEqual(googleCalendarRoutes);
  });
  it('no persiste state/nonce ni respuesta OAuth en el caché de idempotencia', async () => {
    const connect = vi.fn();
    const interceptor = new IdempotenciaInterceptor({ connect } as unknown as Pool);
    const context = { getHandler: () => GoogleCalendarController.prototype.iniciar } as unknown as ExecutionContext;
    const next = { handle: () => of({ state: challenge, nonce: challenge }) };
    expect(await firstValueFrom(interceptor.intercept(context, next))).toEqual({ state: challenge, nonce: challenge });
    expect(connect).not.toHaveBeenCalled();
  });
});

describe('Push autenticado sin trabajo de Google en la petición', () => {
  const pushHeaders = { 'x-goog-resource-state': 'exists', 'x-goog-channel-id': 'channel-test', 'x-goog-channel-token': 'SECRET-CHANNEL', 'x-goog-resource-id': 'resource-test', 'x-goog-message-number': '8' };
  it('sync temprano responde sin resolver ni modificar nada', async () => {
    const response = await post('/webhooks/google/calendar', {}, { 'x-goog-resource-state': 'sync', Authorization: '' });
    expect(response.status).toBe(204); expect(service.authenticate).not.toHaveBeenCalled(); expect(enqueue).not.toHaveBeenCalled();
  });
  it('deriva tenant de canal/recurso y encola solo metadata sin token', async () => {
    service.authenticate.mockResolvedValue('resolved-tenant');
    const response = await post('/webhooks/google/calendar', { arbitrary: 'DO-NOT-QUEUE' }, { ...pushHeaders, Authorization: '', 'X-Tenant-Id': 'forged' });
    expect(response.status).toBe(204);
    expect(enqueue).toHaveBeenCalledWith({ moduleId: 'calendar', tenantId: 'resolved-tenant', channelId: 'channel-test', resourceId: 'resource-test', messageNumber: '8', requestId: expect.any(String) });
    expect(JSON.stringify(enqueue.mock.calls)).not.toMatch(/SECRET-CHANNEL|DO-NOT-QUEUE|forged/);
  });
  it('credencial incorrecta y cola caída nunca se confirman como recibidas', async () => {
    service.authenticate.mockResolvedValue(null);
    expect((await post('/webhooks/google/calendar', {}, pushHeaders)).status).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
    service.authenticate.mockResolvedValue('tenant-a'); enqueue.mockRejectedValueOnce(new Error('PRIVATE-REDIS-URL'));
    const response = await post('/webhooks/google/calendar', {}, pushHeaders);
    expect(response.status).toBe(503); expect(response.headers.get('retry-after')).toBe('5'); expect(await response.text()).not.toContain('PRIVATE');
  });
  it('una cola bloqueada responde reintento a los 800ms, no acusa recibo falso', async () => {
    vi.useFakeTimers();
    try {
      service.authenticate.mockResolvedValue('tenant-a');
      const blocked = vi.fn(() => new Promise<void>(() => {}));
      const controller = new GoogleCalendarWebhookController({ pool: port.pool, enqueue: blocked });
      const setHeader = vi.fn();
      const result = controller.recibir({ headers: pushHeaders, requestId: 'req-timeout' } as unknown as WithRequestId,
        { setHeader } as unknown as Response).then(() => null, error => error);
      await vi.advanceTimersByTimeAsync(800);
      expect(await result).toMatchObject({ status: 503 });
      expect(setHeader).toHaveBeenCalledWith('Retry-After', '5');
      expect(blocked).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});
