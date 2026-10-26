import { expect, test, type Page, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { comoAdmin } from './como-admin';
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
// Cuántos días pide el panel. Desde #1074 viaja la CANTIDAD y no el
// rango: el `from`/`to` lo resuelve el servidor, que es el único de los dos
// que conoce la zona del negocio.
function dias(route: Route) {
  return Number(new URL(route.request().url()).searchParams.get('dias'));
}

function respuesta(route: Route, conversaciones: number) {
  // El simulacro arma el rango como lo armaría el servidor, y lo devuelve en
  // `rango`: un stub que no tiene la forma de la respuesta real deja de
  // proteger justo cuando la respuesta cambia.
  const n = dias(route);
  const dia = (atras: number) => new Date(Date.UTC(2026, 9, 26) - atras * 86_400_000).toISOString().slice(0, 10);
  const rango = { from: dia(n - 1), to: dia(0) };
  return { rango, metrics: { conversaciones_nuevas: conversaciones, resueltas: 12, oportunidades_creadas: 8,
    ganadas: 3, perdidas: 2, valor_ganado_clp: 1234000, ia_ejecuciones: 9, ia_costo_usd: .0123,
    mensajes_enviados: 20, costo_meta_usd: 0, citas_agendadas: 0, pagos_recibidos_clp: 0 },
    primeraRespuesta: { medianaSeg: 45, p90Seg: 150, muestras: 9 }, sinResponderAhora: 2, tasaCierre: .6,
    porDia: [{ day: rango.from, conversaciones: 0, resueltas: 0, oportunidades: 0 },
      { day: rango.to, conversaciones, resueltas: 12, oportunidades: 8 }],
    definiciones: { conversaciones_nuevas: 'Conversaciones creadas en el rango.', resueltas: 'Conversaciones resueltas.', primera_respuesta: 'Tiempo hasta la primera respuesta.' },
    // El período anterior va en el simulacro aunque ninguna de estas pruebas
    // mire la comparación (#588, punto 5): un stub que no tiene la forma de la
    // respuesta real deja de proteger justo cuando la respuesta cambia. Si
    // pintar la tendencia tirara, estas pruebas fallarían, que es lo que un
    // simulacro fiel tiene que hacer. El vacío de `estados-vacios.spec.ts` NO
    // lo lleva, a propósito: ahí se prueba el otro lado, que la pantalla
    // aguante una API que todavía no devuelve el campo.
    anterior: { from: '2025-08-01', to: '2025-08-07', comparable: true,
      metrics: { conversaciones_nuevas: Math.max(0, conversaciones - 10), resueltas: 10 },
      primeraRespuesta: { medianaSeg: 60, muestras: 7 }, tasaCierre: .5 } };
}
const cifra = (page: Page) => page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Conversaciones', exact: true }) }).locator('strong');
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
  /**
   * Lo que cuenta cambió de ruta, y la propiedad quedó más fuerte (#761).
   *
   * Antes se contaban `/v1/modules/catalogo` y `/v1/me/modules/acceso`: eran las
   * dos del menú, y la propiedad era «navegar no las vuelve a pedir». Las dos
   * vienen ahora en `/v1/arranque`, así que lo que hay que contar es el arranque
   * — y es una propiedad MÁS exigente que la de antes, porque ese arranque trae
   * además los avisos, los atajos, las etiquetas, los campos, las empresas y la
   * retención. Si se volviera a pedir en cada navegación, el agrupado habría
   * cambiado dos llamadas repetidas por nueve.
   *
   * UNA vez en toda la sesión: lo pide el proveedor cuando se monta el shell, y
   * el shell no se desmonta al navegar entre pestañas.
   */
  const counts = new Map<string, number>();
  page.on('response', (r) => { const path = new URL(r.url()).pathname; if (['/v1/arranque', '/v1/modules/catalogo', '/v1/me/modules/acceso'].includes(path)) counts.set(path, (counts.get(path) ?? 0) + 1); });
  /**
   * La sección es «Tu negocio» y no «Canales», y el cambio tiene motivo
   * (#814). Esta persona entra como SUPERVISOR, y desde que el menú se filtra
   * por el `permission` de cada entrada, las pestañas de Canales no son suyas:
   * `channels.manage` y `whatsapp.templates.manage` son del ADMIN.
   *
   * Antes de #814 esta prueba navegaba ajustes de Canales como SUPERVISOR y
   * afirmaba que el menú estaba ahí — y estaba, porque el `permission` no lo
   * leía nadie. O sea que la prueba documentaba el defecto. Lo que mide de
   * verdad es cuántas veces se pide el arranque al navegar, y eso no cambia:
   * «Tu negocio» le da dos pestañas que SÍ son suyas, Roles y Equipo.
   */
  await page.goto('/ajustes/roles');
  await expect(page.getByRole('navigation', { name: 'Ajustes de Tu negocio' })).toBeVisible();
  await expect.poll(() => counts.get('/v1/arranque')).toBe(1);
  // Y las dos viejas ya no se piden desde la pantalla: si vuelven, alguien
  // volvió a pedir por su cuenta lo que el arranque ya trae.
  expect(counts.get('/v1/me/modules/acceso')).toBeUndefined();
  await page.evaluate(() => { (window as unknown as Record<string, unknown>).__documento424 = 'mismo'; });
  let documents = 0; page.on('request', (r) => { if (r.isNavigationRequest() && r.resourceType() === 'document') documents++; });
  await page.getByRole('navigation', { name: 'Ajustes de Tu negocio' }).getByRole('link', { name: 'Equipo', exact: true }).click();
  await expect(page).toHaveURL(/\/ajustes\/equipo$/);
  await page.getByRole('link', { name: 'Contactos', exact: true }).click();
  await expect(page).toHaveURL(/\/contactos$/);
  await page.goBack(); await expect(page).toHaveURL(/\/ajustes\/equipo$/);
  expect(documents).toBe(0);
  // Y el arranque sigue en uno después de tres navegaciones y un `goBack`.
  expect(counts.get('/v1/arranque')).toBe(1);
  expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__documento424)).toBe('mismo');
});

/**
 * El menú no ofrece lo que esta persona no puede abrir (#814).
 *
 * Esta prueba nace de un accidente: al filtrar el menú por el `permission` de
 * cada entrada, la prueba de arriba se puso roja porque navegaba ajustes de
 * Canales como SUPERVISOR. O sea que el e2e estaba documentando el defecto.
 * Dejarla arreglada y nada más habría tirado la evidencia, así que la
 * propiedad queda escrita como prueba.
 *
 * Y es la única capa donde se puede comprobar: las pruebas del web corren sin
 * DOM, así que «lo que se dibuja en la barra» solo se ve desde acá.
 *
 * ## Por DESTINO y no por etiqueta, que me costó dos corridas
 *
 * La primera versión afirmaba `getByRole('link', { name: 'Canales' })` y
 * recibía 1. No era que el filtro no funcionara: la barra AGRUPA las entradas
 * por sección, y el enlace que queda se llama como la sección y apunta a la
 * primera pestaña que la persona sí puede abrir. El SUPERVISOR ve `Avisos`
 * (`notifications.manage_own`), que vive en la sección Canales, así que quedaba
 * un `link "Canales"` apuntando a `/ajustes/notificaciones`.
 *
 * O sea que el nombre visible no identifica el destino. El `href` sí.
 */
test('un SUPERVISOR no ve en el menú los destinos del ADMIN (#814)', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto('/contactos');

  /**
   * Lo que SÍ es suyo tiene que estar, y esta mitad es la que importa: una
   * barra vacía satisfaría igual los `toHaveCount(0)` de abajo, y quedarse sin
   * menú por un error al resolver los permisos es peor que ver una puerta que
   * se va a cerrar.
   *
   * Las tres son del plan `base`: el candado por plan (#215) es OTRO mecanismo
   * sobre la misma barra, y una entrada con candado no se dibuja como enlace.
   * Por eso no está «Reportes», que el SUPERVISOR sí puede por permiso y este
   * tenant no tiene por plan.
   */
  for (const suyo of ['/bandeja', '/contactos', '/oportunidades']) {
    await expect(page.locator(`a[href="${suyo}"]`)).toHaveCount(1);
  }

  // Y los destinos que piden un permiso del ADMIN, no: `channels.manage`,
  // `whatsapp.templates.manage`, `crm.fields.manage`, `crm.pipelines.manage`.
  for (const ajeno of ['/ajustes/canales', '/ajustes/plantillas', '/ajustes/campos', '/ajustes/embudos']) {
    await expect(page.locator(`a[href="${ajeno}"]`)).toHaveCount(0);
  }
});

test('API keys pide lista, permisos y consumo juntos, sin esperar tres viajes consecutivos', async ({ page }) => {
  // `/ajustes/api` pide `apikeys.manage`, que es del ADMIN (#815). La prueba
  // de acá arriba comprueba justamente que esta usuaria NO vea esos destinos
  // en el menú, así que el cambio de negocio va por prueba y no en el
  // `beforeEach`: las dos cosas tienen que seguir siendo ciertas.
  await comoAdmin(page, auth);
  const pendientes = new Map<string, Route>();
  for (const path of ['/apikeys', '/apikeys/scopes', '/api-usage']) await page.route('**/v1'+path, (r) => { pendientes.set(path, r); });
  await page.goto('/ajustes/api');
  await expect.poll(() => pendientes.size).toBe(3);
  for (const [path, r] of pendientes) await r.fulfill({ json: path === '/api-usage' ? { limit: null, used: 0, pct: null, porDia: [], topEndpoints: [] } : [] });
  await expect(page.getByText('Todavía no hay llaves.')).toBeVisible();
});
