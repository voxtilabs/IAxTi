// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const auth = vi.hoisted(() => ({ tenant: 'tenant-a', token: 'session-a', user: 'user-a', permissions: ['calendar.connect'] }));
vi.mock('@iaxti/ui/react', async original => ({ ...await original<object>(), useSession: () => ({ config: { apiUrl: 'https://api.example.test' }, session: { access_token: auth.token, user: { id: auth.user } } }) }));
vi.mock('../components/tenant-switcher', () => ({ useSelectedTenant: () => auth.tenant }));
vi.mock('../components/arranque', () => ({ useArranque: () => ({ arranque: { permisos: auth.permissions } }) }));
import { GoogleCalendarCallback, GoogleCalendarConnection } from '../components/google-calendar';
import { googlePkce, readGooglePending, saveGooglePending } from '../lib/google-oauth';
const fetcher = vi.fn<typeof fetch>();
const state = 's'.repeat(43); const nonce = 'n'.repeat(43); const verifier = 'v'.repeat(43);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const disconnected = { configured: true, status: 'disconnected', pushActive: false, calendarId: null, lastNotificationAt: null };
const active = { ...disconnected, status: 'active', calendarId: 'primary' };
const pending = () => ({ tenantId: 'tenant-a', userId: 'user-a', nonce, verifier, createdAt: Date.now(), key: 'finish-key' });
beforeEach(() => {
  auth.tenant = 'tenant-a'; auth.user = 'user-a'; auth.token = 'session-a'; auth.permissions = ['calendar.connect'];
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  vi.stubGlobal('fetch', fetcher); fetcher.mockReset(); sessionStorage.clear(); window.history.replaceState(null, '', '/agenda');
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('PKCE aleatorio S256: el verifier no viaja al iniciar ni la URL inválida se abre', async () => {
  const pair = await googlePkce(); expect(pair.verifier).toHaveLength(43); expect(pair.challenge).toHaveLength(43); expect(pair.verifier).not.toBe(pair.challenge);
  fetcher.mockResolvedValueOnce(json(disconnected)).mockResolvedValueOnce(json({ state, nonce, url: 'https://evil.example.test/' }));
  render(<GoogleCalendarConnection />);
  fireEvent.click(await screen.findByRole('button', { name: 'Conectar Google Calendar' }));
  await screen.findByText('No pudimos abrir el permiso de Google. Intenta nuevamente.');
  const body = JSON.parse(String(fetcher.mock.calls[1][1]?.body)); expect(Object.keys(body)).toEqual(['challenge']); expect(body.challenge).toHaveLength(43);
  expect(sessionStorage.length).toBe(0);
});
it('permiso activo con push pendiente no se declara conexión completa', async () => {
  fetcher.mockResolvedValue(json(active)); render(<GoogleCalendarConnection />);
  expect(await screen.findByText('Permiso conectado')).toBeTruthy();
  expect(screen.getByText(/Las notificaciones de cambios están pendientes/)).toBeTruthy();
  expect(screen.queryByText('Tu calendario quedó conectado.')).toBeNull();
});
it('fallo de carga conserva pista y reintenta sin dibujar un vacío falso', async () => {
  fetcher.mockResolvedValueOnce(json({ code: 'SERVICE_DOWN', message: 'Intenta más tarde.', requestId: 'req-test' }, 503)).mockResolvedValueOnce(json(disconnected));
  render(<GoogleCalendarConnection />);
  expect(await screen.findByText('SERVICE_DOWN · req-test')).toBeTruthy(); expect(screen.queryByText('Sin conectar')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
  expect(await screen.findByText('Sin conectar')).toBeTruthy();
});
it('sin calendar.connect no ofrece acciones de mutación', async () => {
  auth.permissions = []; fetcher.mockResolvedValue(json(active)); render(<GoogleCalendarConnection />);
  await screen.findByText('Permiso conectado'); expect(screen.queryByRole('button', { name: 'Revocar permisos' })).toBeNull();
});
it('cambio de tenant descarta una respuesta tardía y el estado previo', async () => {
  let resolveOld!: (value: Response) => void;
  fetcher.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; })).mockResolvedValueOnce(json(disconnected));
  const view = render(<GoogleCalendarConnection />);
  auth.tenant = 'tenant-b'; view.rerender(<GoogleCalendarConnection />);
  await screen.findByText('Sin conectar');
  await act(async () => resolveOld(json(active)));
  expect(screen.queryByText('Permiso conectado')).toBeNull(); expect(screen.getByText('Sin conectar')).toBeTruthy();
});
it('revocación explica alcance, bloquea doble envío y muestra fallo sin borrar estado', async () => {
  let fail!: (value: Response) => void;
  fetcher.mockResolvedValueOnce(json(active)).mockImplementationOnce(() => new Promise(resolve => { fail = resolve; }));
  render(<GoogleCalendarConnection />); fireEvent.click(await screen.findByRole('button', { name: 'Revocar permisos' }));
  expect(screen.getByText(/también los usados en otros negocios/)).toBeTruthy();
  const button = screen.getByRole('button', { name: 'Revocar permisos de Google' });
  fireEvent.click(button); fireEvent.click(button);
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(button).toBeDisabled();
  await act(async () => fail(json({ code: 'GOOGLE_RETRY', message: 'Reintenta la revocación.', requestId: 'req-revoke' }, 503)));
  expect(screen.getAllByText('GOOGLE_RETRY · req-revoke').length).toBeGreaterThan(0); expect(screen.getByText('Permiso conectado')).toBeTruthy();
});
it('callback limpia código de URL y completa una vez incluso con StrictMode', async () => {
  saveGooglePending(state, pending()); window.history.replaceState(null, '', `/agenda/google/callback?code=private-code&state=${state}`);
  fetcher.mockResolvedValue(json(active)); render(<StrictMode><GoogleCalendarCallback /></StrictMode>);
  expect(await screen.findByText(/El permiso quedó guardado/)).toBeTruthy();
  expect(window.location.search).toBe(''); expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = fetcher.mock.calls[0]; expect(String(url)).toBe('https://api.example.test/v1/agenda/google/completar');
  expect(JSON.parse(String(init?.body))).toEqual({ code: 'private-code', state, nonce, verifier });
  expect(init?.referrerPolicy).toBe('no-referrer'); expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('finish-key');
  expect(sessionStorage.length).toBe(0); expect(document.body.textContent).not.toContain('private-code');
});
it('callback en otro tenant no canjea el permiso guardado', async () => {
  saveGooglePending(state, pending()); auth.tenant = 'tenant-b'; window.history.replaceState(null, '', `/agenda/google/callback?code=private-code&state=${state}`);
  render(<GoogleCalendarCallback />);
  expect(await screen.findByText(/otra sesión o negocio/)).toBeTruthy(); expect(fetcher).not.toHaveBeenCalled();
});
it('rechaza intento expirado o de otro usuario antes de pedir el canje', () => {
  saveGooglePending(state, { ...pending(), createdAt: 1000 });
  expect(() => readGooglePending(state, 'tenant-a', 'user-a', sessionStorage, 601001)).toThrow(/expiró/);
  expect(() => readGooglePending(state, 'tenant-a', 'user-b', sessionStorage, 2000)).toThrow(/otra sesión/);
});
it('denegación de Google limpia el intento y no llama al API', async () => {
  saveGooglePending(state, pending()); window.history.replaceState(null, '', `/agenda/google/callback?error=access_denied&state=${state}`);
  render(<GoogleCalendarCallback />); expect(await screen.findByText(/No autorizaste el acceso/)).toBeTruthy();
  expect(sessionStorage.length).toBe(0); expect(fetcher).not.toHaveBeenCalled();
});
