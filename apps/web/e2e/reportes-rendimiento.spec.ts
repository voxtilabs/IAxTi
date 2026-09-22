import { expect, test, type Page, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const auth = JSON.parse(readFileSync(join(__dirname, '.auth.json'), 'utf8'));
test.beforeEach(async ({ page }) => {
  await page.addInitScript((auth) => {
    localStorage.setItem('iaxti-tenant', auth.tenantId);
    localStorage.setItem('sb-127-auth-token', JSON.stringify({ access_token: auth.accessToken,
      token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: 'e2e', user: { id: auth.userId, aud: 'authenticated', email: 'supervisora@e2e.cl' } }));
  }, auth);
});
function respuesta(route: Route, conversaciones: number) {
  const url = new URL(route.request().url());
  return { metrics: { conversaciones_nuevas: conversaciones, resueltas: 12, oportunidades_creadas: 8,
    ganadas: 3, perdidas: 2, valor_ganado_clp: 1234000, ia_ejecuciones: 9, ia_costo_usd: .0123,
    mensajes_enviados: 20, costo_meta_usd: 0, citas_agendadas: 0, pagos_recibidos_clp: 0 },
    primeraRespuesta: { medianaSeg: 45, p90Seg: 150, muestras: 9 }, sinResponderAhora: 2, tasaCierre: .6,
    porDia: [{ day: url.searchParams.get('from')!, conversaciones: 0, resueltas: 0, oportunidades: 0 },
      { day: url.searchParams.get('to')!, conversaciones, resueltas: 12, oportunidades: 8 }],
    definiciones: { conversaciones_nuevas: 'Conversaciones creadas en el rango.', resueltas: 'Conversaciones resueltas.', primera_respuesta: 'Tiempo hasta la primera respuesta.' } };
}
const cifra = (page: Page) => page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Conversaciones', exact: true }) }).locator('strong');
function dias(route: Route) {
  const url = new URL(route.request().url());
  return Math.round((Date.parse(url.searchParams.get('to')!) - Date.parse(url.searchParams.get('from')!)) / 86_400_000) + 1;
}

test('rangos rápidos: gana la selección más reciente, aunque la respuesta anterior llegue después', async ({ page }) => {
  let pendiente: Route | undefined;
  await page.route('**/v1/analytics/dashboard?*', async (r) => {
    if (dias(r) === 7) { pendiente = r; return; }
    await r.fulfill({ json: respuesta(r, dias(r) === 90 ? 900 : 300) });
  });
  await page.goto('/reportes'); await expect(cifra(page)).toHaveText('300');
  await page.getByRole('tab', { name: '7 días', exact: true }).click();
  await expect.poll(() => !!pendiente).toBe(true);
  await page.getByRole('tab', { name: '90 días', exact: true }).click();
  await expect(cifra(page)).toHaveText('900');
  await pendiente!.fulfill({ json: respuesta(pendiente!, 700) }).catch(() => {});
  await expect(cifra(page)).toHaveText('900');
  await expect(page.getByRole('tab', { name: '90 días', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('volver a un rango conserva la lectura, la revalida y permite recuperar errores', async ({ page }) => {
  let n30 = 0, retenida: Route | undefined, fallo = false;
  await page.route('**/v1/analytics/dashboard?*', async (r) => {
    if (fallo) { await r.fulfill({ status: 503, json: { message: 'Reporte temporalmente no disponible.' } }); return; }
    if (dias(r) === 30 && ++n30 === 2) { retenida = r; return; }
    await r.fulfill({ json: respuesta(r, dias(r) === 7 ? 700 : 300) });
  });
  await page.goto('/reportes'); await expect(cifra(page)).toHaveText('300');
  await page.getByRole('tab', { name: '7 días', exact: true }).click(); await expect(cifra(page)).toHaveText('700');
  await page.getByRole('tab', { name: '30 días', exact: true }).click();
  await expect.poll(() => !!retenida).toBe(true);
  await expect(cifra(page)).toHaveText('300');
  await expect(page.getByText('Actualizando datos…')).toBeVisible();
  await retenida!.fulfill({ json: respuesta(retenida!, 301) }); await expect(cifra(page)).toHaveText('301');
  fallo = true; await page.getByRole('button', { name: 'Actualizar reportes' }).click();
  await expect(page.getByRole('region', { name: 'Reportes del negocio' }).getByText(/Reporte temporalmente no disponible/)).toBeVisible();
  await expect(cifra(page)).toHaveText('301');
  fallo = false; await page.getByRole('button', { name: 'Actualizar reportes' }).click();
  await expect(cifra(page)).toHaveText('300'); await expect(page.getByRole('region', { name: 'Reportes del negocio' }).getByText(/Reporte temporalmente no disponible/)).toHaveCount(0);
});

test('el negocio nuevo no ve la lectura anterior, y un 403 limpia la memoria visible', async ({ page }) => {
  const otro = '00000000-0000-4000-8000-000000000424';
  let retener = false, denegar = false; const pendientes: Route[] = [];
  await page.route('**/v1/analytics/dashboard?*', async (r) => {
    if (denegar) { await r.fulfill({ status: 403, json: { message: 'Ya no tienes acceso a estos reportes.' } }); return; }
    if (retener) { pendientes.push(r); return; }
    await r.fulfill({ json: respuesta(r, 300) });
  });
  await page.goto('/reportes'); await expect(cifra(page)).toHaveText('300');
  retener = true;
  await page.evaluate((id) => { localStorage.setItem('iaxti-tenant', id); window.dispatchEvent(new Event('iaxti-tenant-changed')); }, otro);
  await expect(cifra(page)).toHaveCount(0);
  await expect.poll(() => pendientes.length).toBeGreaterThan(0);
  expect(pendientes[0].request().headers()['x-tenant-id']).toBe(otro);
  await pendientes[0].fulfill({ json: respuesta(pendientes[0], 424) });
  await expect(cifra(page)).toHaveText('424');
  denegar = true; await page.getByRole('button', { name: 'Actualizar reportes' }).click();
  await expect(page.getByRole('region', { name: 'Reportes del negocio' }).getByText(/Ya no tienes acceso/)).toBeVisible(); await expect(cifra(page)).toHaveCount(0);
});

for (const mode of ['dia', 'noche']) test(`gráficos en ${mode}: escala, teclado, tabla diaria y cero real a 360 px`, async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.addInitScript((mode) => localStorage.setItem('pulso-mode', mode), mode);
  await page.route('**/v1/analytics/dashboard?*', (r) => r.fulfill({ json: respuesta(r, 300) }));
  await page.goto('/reportes'); await expect(cifra(page)).toHaveText('300');
  await expect(page.getByRole('img', { name: 'Conversaciones nuevas y resueltas por día' })).toBeVisible();
  const selector = page.getByRole('slider', { name: 'Elegir día del gráfico' }).first();
  await selector.focus(); await selector.press('Home');
  await expect(selector).toHaveAttribute('aria-valuetext', /0 conversaciones, 0 resueltas/);
  await selector.press('End'); await expect(selector).toHaveAttribute('aria-valuetext', /300 conversaciones, 12 resueltas/);
  await page.getByText('Ver datos por día', { exact: true }).click();
  await expect(page.getByRole('table').getByRole('row')).toHaveCount(31);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('navegar por menú, pestañas y volver no recarga el documento ni duplica las consultas del menú', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const counts = new Map<string, number>();
  page.on('response', (r) => { const path = new URL(r.url()).pathname; if (['/v1/me/modules', '/v1/me/modules/acceso'].includes(path)) counts.set(path, (counts.get(path) ?? 0) + 1); });
  await page.goto('/ajustes/canales');
  await expect(page.getByRole('navigation', { name: 'Ajustes de Canales' })).toBeVisible();
  await expect.poll(() => counts.get('/v1/me/modules/acceso')).toBe(1);
  expect(counts.get('/v1/me/modules')).toBe(1);
  await page.evaluate(() => { (window as unknown as Record<string, unknown>).__documento424 = 'mismo'; });
  let documents = 0; page.on('request', (r) => { if (r.isNavigationRequest() && r.resourceType() === 'document') documents++; });
  await page.getByRole('navigation', { name: 'Ajustes de Canales' }).getByRole('link', { name: 'Plantillas', exact: true }).click();
  await expect(page).toHaveURL(/\/ajustes\/plantillas$/);
  await page.getByRole('link', { name: 'Contactos', exact: true }).click();
  await expect(page).toHaveURL(/\/contactos$/);
  await page.goBack(); await expect(page).toHaveURL(/\/ajustes\/plantillas$/);
  expect(documents).toBe(0);
  expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__documento424)).toBe('mismo');
});

test('API keys pide lista, permisos y consumo juntos, sin esperar tres viajes consecutivos', async ({ page }) => {
  const pendientes = new Map<string, Route>();
  for (const path of ['/apikeys', '/apikeys/scopes', '/api-usage']) await page.route('**/v1'+path, (r) => { pendientes.set(path, r); });
  await page.goto('/ajustes/api');
  await expect.poll(() => pendientes.size).toBe(3);
  for (const [path, r] of pendientes) await r.fulfill({ json: path === '/api-usage' ? { limit: null, used: 0, pct: null, porDia: [], topEndpoints: [] } : [] });
  await expect(page.getByText('Todavía no hay llaves.')).toBeVisible();
});
