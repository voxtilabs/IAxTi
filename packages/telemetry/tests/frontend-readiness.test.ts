import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { frontendReadiness } from '../src/frontend-readiness';

let server: Server;
let origin: string;
let mode: 'ok' | 'api-down' | 'auth-down' | 'invalid' | 'auth-invalid' | 'stall' | 'redirect' = 'ok';
const credentials = 'public-test-key';
const requests: Array<{ path: string; apikey: string | undefined }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url!;
    requests.push({ path, apikey: req.headers.apikey as string | undefined });
    if (mode === 'stall') return;
    if (mode === 'redirect') { res.writeHead(302, { location: '/unexpected' }); res.end(); return; }
    const down = (mode === 'api-down' && path === '/ready') || (mode === 'auth-down' && path === '/auth/v1/health');
    res.writeHead(down ? 503 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(path === '/ready'
      ? { status: mode === 'invalid' ? 'degraded' : 'ok' }
      : { name: mode === 'auth-invalid' ? 'proxy' : 'GoTrue' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});
const env = () => ({ API_URL_INTERNAL: origin, SUPABASE_URL: origin, SUPABASE_ANON_KEY: credentials });

describe('readiness real de web y admin (#17)', () => {
  it.each(['web', 'admin'] as const)('%s está listo cuando API y Auth responden', async service => {
    mode = 'ok'; requests.length = 0;
    const result = await frontendReadiness(service, env());
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(await result.json()).toMatchObject({ status: 'ok', service, dependencias: [
      { nombre: 'api', ok: true }, { nombre: 'supabase_auth', ok: true },
    ] });
    expect(requests).toContainEqual({ path: '/ready', apikey: undefined });
    expect(requests).toContainEqual({ path: '/auth/v1/health', apikey: credentials });
  });

  it.each(['api-down', 'auth-down', 'invalid', 'auth-invalid'] as const)('%s deja el servicio no listo', async failure => {
    mode = failure;
    const result = await frontendReadiness('web', env());
    expect(result.status).toBe(503);
    expect((await result.json()).status).toBe('degraded');
  });

  it('sin configuración responde 503 sin consultar localhost ni servicios ficticios', async () => {
    requests.length = 0;
    const result = await frontendReadiness('admin', {});
    expect(result.status).toBe(503);
    expect(requests).toEqual([]);
    expect((await result.json()).dependencias.every((d: { ok: boolean }) => !d.ok)).toBe(true);
  });

  it('la API pública sirve de respaldo cuando no se declara URL interna', async () => {
    mode = 'ok';
    const result = await frontendReadiness('web', { ...env(), API_URL_INTERNAL: undefined, API_URL_PUBLIC: origin });
    expect(result.status).toBe(200);
  });

  it('sin clave Auth marca la dependencia sin configurar y no la consulta', async () => {
    mode = 'ok'; requests.length = 0;
    const result = await frontendReadiness('admin', { ...env(), SUPABASE_ANON_KEY: undefined });
    expect(result.status).toBe(503);
    expect((await result.json()).dependencias).toContainEqual({ nombre: 'supabase_auth', ok: false, ms: 0, detalle: 'sin configurar' });
    expect(requests).toEqual([{ path: '/ready', apikey: undefined }]);
  });

  it('corta una dependencia que no responde y no filtra URL, clave ni error interno', async () => {
    mode = 'stall';
    const before = Date.now();
    const result = await frontendReadiness('admin', env(), 50);
    expect(result.status).toBe(503);
    expect(Date.now() - before).toBeLessThan(1_000);
    const body = await result.text();
    expect(body).not.toContain(origin);
    expect(body).not.toContain(credentials);
    expect(body).toContain('no respondió a tiempo');
  });

  it('no sigue redirects ni transmite la clave a otro destino', async () => {
    mode = 'redirect'; requests.length = 0;
    expect((await frontendReadiness('web', env())).status).toBe(503);
    expect(requests.some(r => r.path === '/unexpected')).toBe(false);
  });

  it('una URL inválida no expone su valor ni rompe la sonda', async () => {
    mode = 'ok';
    const result = await frontendReadiness('web', { ...env(), API_URL_INTERNAL: 'no-es-url-valor-privado' });
    expect(result.status).toBe(503);
    expect(await result.text()).not.toContain('valor-privado');
  });
});
