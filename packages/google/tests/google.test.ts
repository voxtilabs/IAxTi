import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGoogleCalendarClient, createGoogleOAuth, createGoogleSecretStore,
  GOOGLE_CALENDAR_SCOPE, GoogleIntegrationError } from '../src';

const config = { clientId: 'client-test.apps.googleusercontent.com', clientSecret: 'secret-test-only', redirectUri: 'https://app.example.test/google/callback' };
const verifier = 'a'.repeat(43);
const tokenResponse = { access_token: 'access-test', refresh_token: 'refresh-test', expires_in: 3600,
  token_type: 'Bearer', scope: `openid ${GOOGLE_CALENDAR_SCOPE}`, id_token: 'id-test' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const bodyOf = (call: Parameters<typeof fetch>) => JSON.parse(String(call[1]?.body)) as Record<string, unknown>;
afterEach(() => vi.useRealTimers());

describe('OAuth por el transporte real del paquete', () => {
  it('pide offline incremental y PKCE S256, sin propagar el client secret al navegador', () => {
    const oauth = createGoogleOAuth(config);
    const url = new URL(oauth.authorizationUrl({ state: 'state-test', nonce: 'nonce-test', challenge: verifier, scopes: ['openid', GOOGLE_CALENDAR_SCOPE] }));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ response_type: 'code', access_type: 'offline',
      include_granted_scopes: 'true', code_challenge_method: 'S256', code_challenge: verifier, nonce: 'nonce-test', state: 'state-test' });
    expect(url.searchParams.get('scope')).toBe(`openid ${GOOGLE_CALENDAR_SCOPE}`);
    expect(url.href).not.toContain(config.clientSecret);
  });
  it('canjea código y conserva scopes efectivos; refresh puede no devolver refresh_token', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(json(tokenResponse)).mockResolvedValueOnce(json({
      access_token: 'new-access', token_type: 'Bearer', expires_in: 1200, scope: 'openid',
    }));
    const oauth = createGoogleOAuth(config, { fetch: send });
    expect(await oauth.exchange({ code: 'code-test', verifier })).toEqual({ accessToken: 'access-test', refreshToken: 'refresh-test',
      expiresIn: 3600, scope: ['openid', GOOGLE_CALENDAR_SCOPE], idToken: 'id-test' });
    const first = send.mock.calls[0];
    expect(first[0]).toBe('https://oauth2.googleapis.com/token');
    expect(Object.fromEntries(new URLSearchParams(String(first[1]?.body)))).toMatchObject({
      code: 'code-test', code_verifier: verifier, grant_type: 'authorization_code', client_secret: config.clientSecret, redirect_uri: config.redirectUri,
    });
    expect(first[1]?.redirect).toBe('error');
    expect(await oauth.refresh('refresh-test')).toEqual({ accessToken: 'new-access', expiresIn: 1200, scope: ['openid'] });
    expect(new URLSearchParams(String(send.mock.calls[1][1]?.body)).get('grant_type')).toBe('refresh_token');
  });
  it('revoke envía el secreto solo en cuerpo y admite respuesta vacía', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    await createGoogleOAuth(config, { fetch: send }).revoke('private-test-token');
    expect(send.mock.calls[0][0]).toBe('https://oauth2.googleapis.com/revoke');
    expect(String(send.mock.calls[0][1]?.body)).toBe('token=private-test-token');
  });
  it.each([
    {}, { ...tokenResponse, expires_in: -1 }, { ...tokenResponse, access_token: '' },
    { ...tokenResponse, token_type: 'unexpected' }, { ...tokenResponse, refresh_token: null },
  ])('rechaza una respuesta de token inválida %#', async (response) => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(json(response));
    await expect(createGoogleOAuth(config, { fetch: send }).exchange({ code: 'c', verifier })).rejects.toMatchObject({ code: 'GOOGLE_RESPONSE_INVALID' });
  });
  it('invalid_grant conserva una clasificación útil sin mensaje ni request externos', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(json({ error: 'invalid_grant', error_description: 'PRIVATE-REFRESH-TOKEN' }, 400));
    const error = await createGoogleOAuth(config, { fetch: send }).refresh('private-refresh').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoogleIntegrationError);
    expect(error).toMatchObject({ code: 'GOOGLE_INVALID_GRANT', status: 400 });
    expect(JSON.stringify(error)).not.toMatch(/PRIVATE|private-refresh|request|cause/);
  });
  it('errores del transporte no conservan secretos en message/cause/stack', async () => {
    const send = vi.fn<typeof fetch>().mockRejectedValue(Object.assign(new Error('PRIVATE-SECRET'), { request: { token: 'PRIVATE-SECRET' } }));
    const error = await createGoogleOAuth(config, { fetch: send }).refresh('r').catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'GOOGLE_REQUEST_FAILED' });
    expect(JSON.stringify(error) + String(error)).not.toContain('PRIVATE-SECRET');
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
  });
  it('revoke clasifica invalid_token sin convertirlo en éxito ni exponer el token', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(json({ error: 'invalid_token', error_description: 'PRIVATE-TOKEN' }, 400));
    const error = await createGoogleOAuth(config, { fetch: send }).revoke('private-token').catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'GOOGLE_INVALID_TOKEN', status: 400 });
    expect(JSON.stringify(error) + String(error)).not.toMatch(/PRIVATE-TOKEN|private-token/);
  });
  it('el deadline cancela fetch y un caller ya cancelado no envía nada', async () => {
    vi.useFakeTimers();
    const send = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('cancelled-private-request')), { once: true });
    }));
    const oauth = createGoogleOAuth(config, { fetch: send, timeoutMs: 50 });
    const timeout = expect(oauth.refresh('r')).rejects.toMatchObject({ code: 'GOOGLE_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(50); await timeout;
    expect(send.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await expect(oauth.refresh('r', { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'GOOGLE_REQUEST_ABORTED' });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it.each(['https://attacker.test/callback#fragment', 'http://app.test/callback', 'https://user:password@app.test/callback'])('rechaza redirect no seguro %s', (redirectUri) => {
    expect(() => createGoogleOAuth({ ...config, redirectUri })).toThrow(GoogleIntegrationError);
  });
});

describe('ID token: SDK oficial y firma RSA real, sin red externa', () => {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  function jwt(overrides: Record<string, unknown> = {}, wrongSignature = false) {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: config.clientId,
      sub: 'google-sub-123', nonce: 'nonce-test', iat: now, exp: now + 3600, ...overrides })).toString('base64url');
    const input = `${header}.${payload}`;
    const signature = sign('RSA-SHA256', Buffer.from(input), keys.privateKey).toString('base64url');
    return `${input}.${wrongSignature ? 'not-a-valid-signature' : signature}`;
  }
  it('valida firma, issuer, audience, nonce y devuelve sub; email solo si está verificado', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(json({ 'test-key': pem }));
    const identity = await createGoogleOAuth(config, { fetch: send }).verifyIdToken({
      idToken: jwt({ email: 'test@example.test', email_verified: true }), nonce: 'nonce-test',
    });
    expect(identity).toEqual({ sub: 'google-sub-123', email: 'test@example.test' });
    expect(send.mock.calls[0][0]).toBe('https://www.googleapis.com/oauth2/v1/certs');
  });
  it.each([
    { aud: 'another-client' }, { iss: 'https://attacker.test' }, { nonce: 'another-nonce' },
    { exp: 1 }, { sub: '' }, { azp: 'another-client' },
  ])('no acepta claims equivocados %#', async (claims) => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(json({ 'test-key': pem }));
    await expect(createGoogleOAuth(config, { fetch: send }).verifyIdToken({ idToken: jwt(claims), nonce: 'nonce-test' }))
      .rejects.toMatchObject({ code: 'GOOGLE_ID_TOKEN_INVALID' });
  });
  it('no acepta firma alterada', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(json({ 'test-key': pem }));
    await expect(createGoogleOAuth(config, { fetch: send }).verifyIdToken({ idToken: jwt({}, true), nonce: 'nonce-test' }))
      .rejects.toMatchObject({ code: 'GOOGLE_ID_TOKEN_INVALID' });
  });
});

describe('Secret Manager REST y referencias inmutables', () => {
  const secret = 'projects/project-test/secrets/random-test-uuid';
  const version = `${secret}/versions/7`;
  const store = (send: typeof fetch) => createGoogleSecretStore({ projectId: 'project-test', location: 'southamerica-west1' }, {
    fetch: send, accessToken: async () => 'adc-test',
  });
  it('crea en ubicación explícita, añade versión y comprueba CRC32C publicado de 123456789', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ name: secret })).mockResolvedValueOnce(json({ name: version, state: 'ENABLED' }));
    expect(await store(send).put('random-test-uuid', '123456789')).toBe(version);
    expect(bodyOf(send.mock.calls[0])).toEqual({ replication: { userManaged: { replicas: [{ location: 'southamerica-west1' }] } } });
    expect(send.mock.calls[1][0]).toBe(`https://secretmanager.googleapis.com/v1/${secret}:addVersion`);
    expect(bodyOf(send.mock.calls[1])).toEqual({ payload: { data: Buffer.from('123456789').toString('base64'), dataCrc32c: '3808858755' } });
    expect(new Headers(send.mock.calls[1][1]?.headers).get('Authorization')).toBe('Bearer adc-test');
  });
  it('lee solo versión numérica del proyecto y verifica identidad/checksum antes de devolver bytes', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(json({ name: version, payload: { data: 'MTIzNDU2Nzg5', dataCrc32c: '3808858755' } }));
    expect(await store(send).access(version)).toBe('123456789');
    expect(send.mock.calls[0][0]).toBe(`https://secretmanager.googleapis.com/v1/${version}:access`);
  });
  it.each([`${secret}/versions/latest`, 'projects/other-project/secrets/other/versions/7', `${secret}/versions/7?x=1`, `${secret}/versions/../7`])('bloquea ref no vinculada/inmutable %s antes de ADC/fetch', async (ref) => {
    const send = vi.fn<typeof fetch>();
    await expect(store(send).access(ref)).rejects.toMatchObject({ code: 'GOOGLE_INPUT_INVALID' });
    expect(send).not.toHaveBeenCalled();
  });
  it.each([
    { name: 'projects/other-project/secrets/x/versions/7', payload: { data: 'MTIzNDU2Nzg5', dataCrc32c: '3808858755' } },
    { name: version, payload: { data: 'MTIzNDU2Nzg5', dataCrc32c: '0' } },
    { name: version, payload: { data: '!not-base64!', dataCrc32c: '0' } },
  ])('no devuelve payload si falla referencia o integridad %#', async (response) => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(json(response));
    await expect(store(send).access(version)).rejects.toMatchObject({ code: 'GOOGLE_RESPONSE_INVALID' });
  });
  it('destruye la versión concreta y repetir DESTROYED no envía otra destrucción', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ name: version, state: 'ENABLED' }))
      .mockResolvedValueOnce(json({ name: version, state: 'DESTROYED' }))
      .mockResolvedValueOnce(json({ name: version, state: 'DESTROYED' }));
    const secrets = store(send); await secrets.destroy(version); await secrets.destroy(version);
    expect(send.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      [`https://secretmanager.googleapis.com/v1/${version}`, 'GET'],
      [`https://secretmanager.googleapis.com/v1/${version}:destroy`, 'POST'],
      [`https://secretmanager.googleapis.com/v1/${version}`, 'GET'],
    ]);
  });
  it('tolera otra destrucción concurrente pero no oculta un fallo de acceso', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ name: version, state: 'ENABLED' }))
      .mockResolvedValueOnce(json({ error: { status: 'FAILED_PRECONDITION', message: 'external-private-text' } }, 400))
      .mockResolvedValueOnce(json({ name: version, state: 'DESTROYED' }));
    await expect(store(send).destroy(version)).resolves.toBeUndefined();
    const forbidden = vi.fn<typeof fetch>().mockResolvedValue(json({ error: 'private-text' }, 403));
    await expect(store(forbidden).destroy(version)).rejects.toMatchObject({ code: 'GOOGLE_PERMISSION_DENIED' });
  });
  it('acota ADC y cancelar antes de obtener credenciales no inicia HTTP', async () => {
    vi.useFakeTimers();
    const accessToken = vi.fn<() => Promise<string>>().mockImplementation(() => new Promise(() => {}));
    const send = vi.fn<typeof fetch>();
    const secrets = createGoogleSecretStore({ projectId: 'project-test', location: 'southamerica-west1' }, {
      fetch: send, accessToken, timeoutMs: 50,
    });
    await expect(secrets.access(version, { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'GOOGLE_REQUEST_ABORTED' });
    expect(accessToken).not.toHaveBeenCalled();
    const deadline = expect(secrets.access(version)).rejects.toMatchObject({ code: 'GOOGLE_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(50); await deadline;
    const abort = new AbortController();
    const cancelled = expect(secrets.access(version, { signal: abort.signal })).rejects.toMatchObject({ code: 'GOOGLE_REQUEST_ABORTED' });
    abort.abort(); await cancelled;
    expect(send).not.toHaveBeenCalled();
  });
  it('limpia un secreto de intención pendiente por ID validado, 404 es idempotente y 403 no', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(json({}, 404)).mockResolvedValueOnce(json({ message: 'PRIVATE' }, 403));
    const secrets = store(send);
    await secrets.deleteSecret('random-test-uuid');
    expect(send.mock.calls[0][0]).toBe(`https://secretmanager.googleapis.com/v1/${secret}`);
    expect(send.mock.calls[0][1]?.method).toBe('DELETE');
    await expect(secrets.deleteSecret('random-test-uuid')).resolves.toBeUndefined();
    await expect(secrets.deleteSecret('random-test-uuid')).rejects.toMatchObject({ code: 'GOOGLE_PERMISSION_DENIED' });
    await expect(secrets.deleteSecret('../another')).rejects.toMatchObject({ code: 'GOOGLE_INPUT_INVALID' });
    expect(send).toHaveBeenCalledTimes(3);
  });
  it('guarda texto UTF-8 multilinea, pero rechaza bytes excesivos antes de crear', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(json({ name: version, state: 'ENABLED' }));
    await store(send).addVersion('random-test-uuid', 'línea uno\nlínea dos');
    const body = bodyOf(send.mock.calls[0]) as { payload: { data: string } };
    expect(Buffer.from(body.payload.data, 'base64').toString('utf8')).toBe('línea uno\nlínea dos');
    send.mockClear();
    await expect(store(send).put('random-test-uuid', 'á'.repeat(32769))).rejects.toMatchObject({ code: 'GOOGLE_INPUT_INVALID' });
    expect(send).not.toHaveBeenCalled();
  });
});

describe('Calendar: ocupación real, ningún error convertido en libre', () => {
  const input = { accessToken: 'access-test', calendarIds: ['primary'], timeMin: '2026-10-16T00:00:00-03:00', timeMax: '2026-10-17T00:00:00-03:00', timeZone: 'America/Santiago' };
  it('conserva intervalos RFC3339 sin convertirlos a la zona del servidor', async () => {
    const busy = [{ start: '2026-10-16T23:30:00-03:00', end: '2026-10-17T01:00:00-03:00' }];
    const send = vi.fn<typeof fetch>().mockResolvedValue(json({ calendars: { primary: { busy } } }));
    expect(await createGoogleCalendarClient({ fetch: send }).freebusy(input)).toEqual({ primary: busy });
    expect(send.mock.calls[0][0]).toBe('https://www.googleapis.com/calendar/v3/freeBusy');
    expect(bodyOf(send.mock.calls[0])).toEqual({ timeMin: input.timeMin, timeMax: input.timeMax, timeZone: input.timeZone, items: [{ id: 'primary' }] });
  });
  it.each([
    { calendars: {} }, { calendars: { primary: { errors: [{ reason: 'notFound' }], busy: [] } } },
    { calendars: { primary: {} } }, { calendars: { primary: { errors: 'unexpected', busy: [] } } },
  ])('HTTP200 con error parcial o calendario ausente falla %#', async (response) => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(json(response));
    await expect(createGoogleCalendarClient({ fetch: send }).freebusy(input)).rejects.toMatchObject({ code: 'GOOGLE_FREEBUSY_UNAVAILABLE' });
  });
  it.each([
    { busy: [{ start: 'not-a-date', end: input.timeMax }] }, { busy: [{ start: input.timeMax, end: input.timeMin }] },
    { busy: [{ start: '2026-10-16T01:00:00', end: input.timeMax }] },
    { busy: [{ start: '2026-02-30T01:00:00Z', end: input.timeMax }] },
  ])('rechaza intervalos malformados %#', async ({ busy }) => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(json({ calendars: { primary: { busy } } }));
    await expect(createGoogleCalendarClient({ fetch: send }).freebusy(input)).rejects.toMatchObject({ code: 'GOOGLE_RESPONSE_INVALID' });
  });
  it('watch envía token/expiración sin ponerlos enURL y stop usa solo id/recurso', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ id: 'channel-test', resourceId: 'resource-test', expiration: '1893456000000' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createGoogleCalendarClient({ fetch: send });
    expect(await client.watch({ accessToken: 'a', calendarId: 'someone@example.test', channelId: 'channel-test', channelToken: 'push-secret-test',
      address: 'https://app.example.test/google/push', expiration: 1893456000000 })).toEqual({ id: 'channel-test', resourceId: 'resource-test', expiration: 1893456000000 });
    expect(send.mock.calls[0][0]).toBe('https://www.googleapis.com/calendar/v3/calendars/someone%40example.test/events/watch');
    expect(bodyOf(send.mock.calls[0])).toMatchObject({ token: 'push-secret-test', type: 'web_hook', expiration: '1893456000000' });
    await client.stop({ accessToken: 'a', channelId: 'channel-test', resourceId: 'resource-test' });
    expect(send.mock.calls[1][0]).toBe('https://www.googleapis.com/calendar/v3/channels/stop');
    expect(bodyOf(send.mock.calls[1])).toEqual({ id: 'channel-test', resourceId: 'resource-test' });
  });
  it.each([true, {}, 'NaN', '-1'])('rechaza expiración inválida de watch %#', async (expiration) => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(json({ id: 'channel-test', resourceId: 'resource-test', expiration }));
    await expect(createGoogleCalendarClient({ fetch: send }).watch({ accessToken: 'a', calendarId: 'primary', channelId: 'channel-test',
      channelToken: 'push-secret', address: 'https://app.example.test/google/push', expiration: 1893456000000 }))
      .rejects.toMatchObject({ code: 'GOOGLE_RESPONSE_INVALID' });
  });
});
