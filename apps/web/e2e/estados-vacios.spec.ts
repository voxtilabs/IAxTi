import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const auth = JSON.parse(readFileSync(join(__dirname, '.auth.json'), 'utf8'));
test.beforeEach(async ({ page }) => {
  await page.addInitScript((auth) => {
    localStorage.setItem('iaxti-tenant', auth.tenantId);
    localStorage.setItem('sb-127-auth-token', JSON.stringify({
      access_token: auth.accessToken, token_type: 'bearer', expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'e2e',
      user: { id: auth.userId, aud: 'authenticated', email: 'supervisora@e2e.cl' },
    }));
  }, auth);
});

async function comprobarAccion(page: Page, titulo: string, accion: string, destino: string) {
  const vacio = page.getByRole('region', { name: titulo, exact: true });
  await expect(vacio).toBeVisible();
  await expect(vacio.getByRole('link', { name: accion })).toHaveAttribute('href', destino);
}

test('contactos: distingue cartera vacía de búsqueda y permite limpiarla', async ({ page }) => {
  await page.route('**/v1/contacts?*', (r) => r.fulfill({ json: { items: [], nextCursor: null } }));
  await page.goto('/contactos');
  await comprobarAccion(page, 'Aquí empieza tu cartera de contactos', 'Importar contactos', '/contactos/importar');
  await page.getByRole('searchbox', { name: 'Buscar contactos' }).fill('carlos');
  await expect(page.getByRole('heading', { name: 'Nada con “carlos”' })).toBeVisible();
  await page.getByRole('button', { name: 'Limpiar búsqueda' }).click();
  await expect(page.getByRole('searchbox', { name: 'Buscar contactos' })).toHaveValue('');
  await expect(page.getByRole('heading', { name: 'Aquí empieza tu cartera de contactos' })).toBeVisible();
});

test('bandeja: ofrece conectar el canal, cambiar de cola y limpiar una búsqueda', async ({ page }) => {
  await page.route('**/v1/conversations{,?*}', (r) => r.fulfill({ json: { items: [] } }));
  await page.route('**/v1/search?*', (r) => r.fulfill({ json: [] }));
  await page.goto('/bandeja');
  await comprobarAccion(page, 'Todavía no te escribe nadie', 'Conectar WhatsApp', '/ajustes/canales');
  await page.getByRole('tab', { name: 'Mi cola' }).click();
  await page.getByRole('button', { name: 'Ver todas las conversaciones' }).click();
  await expect(page.getByRole('heading', { name: 'Todavía no te escribe nadie' })).toBeVisible();
  const buscar = page.getByRole('searchbox', { name: 'Buscar en mensajes y notas' });
  await buscar.fill('carlos');
  await buscar.press('Enter');
  await expect(page.getByRole('heading', { name: 'Nada con “carlos”' })).toBeVisible();
  await page.getByRole('button', { name: 'Limpiar búsqueda' }).click();
  await expect(buscar).toHaveValue('');
});

test('oportunidades sin embudo indican dónde configurarlo', async ({ page }) => {
  await page.route('**/v1/pipelines', (r) => r.fulfill({ json: [] }));
  await page.goto('/oportunidades');
  await comprobarAccion(page, 'Prepara las etapas de tus ventas', 'Configurar mi negocio', '/ajustes/ia');
});

test('plantillas y automatizaciones enfocan el control que inicia la tarea', async ({ page }) => {
  await page.route('**/v1/plantillas', (r) => r.fulfill({ json: [] }));
  await page.goto('/ajustes/plantillas');
  await page.getByRole('button', { name: 'Escribir una plantilla' }).click();
  await expect(page.locator('#nombre-plantilla')).toBeFocused();
  await page.route('**/v1/automations{,/runs}', (r) => r.fulfill({ json: [] }));
  await page.goto('/ajustes/automatizaciones');
  await page.getByRole('button', { name: 'Elegir rubro' }).click();
  await expect(page.getByRole('combobox', { name: 'Rubro' })).toBeFocused();
});

test('reportes explica el período sin actividad y lleva a atender', async ({ page }) => {
  await page.route('**/v1/analytics/dashboard?*', (r) => r.fulfill({ json: {
    metrics: { ia_costo_usd: 0 }, definiciones: {}, porDia: [],
    primeraRespuesta: { medianaSeg: null, p90Seg: null, muestras: 0 }, sinResponderAhora: 0, tasaCierre: null,
  } }));
  await page.goto('/reportes');
  await comprobarAccion(page, 'Todavía no hay movimiento en este período', 'Abrir la bandeja', '/bandeja');
});

const progreso = {
  estadoRegistrado: 'registered', completo: false, siguiente: 'configured', desfase: [],
  pasos: [
    { id: 'configured', titulo: 'Cuéntanos de tu negocio', ayuda: 'Describe a qué te dedicas.', opcional: false, hecho: false, bloqueado: false, detalle: null, fuente: 'verificado', ruta: '/ajustes/ia' },
    { id: 'whatsapp_connected', titulo: 'Conecta tu WhatsApp', ayuda: 'Conecta el número del negocio.', opcional: false, hecho: true, bloqueado: false, detalle: null, fuente: 'verificado', ruta: '/ajustes/canales' },
    { id: 'team_invited', titulo: 'Invita a tu equipo', ayuda: 'Invita a quienes atienden.', opcional: true, hecho: false, bloqueado: false, detalle: null, fuente: 'historial', ruta: '/ajustes/equipo' },
  ],
};

test('el avance usa hechos del servidor, se refresca al volver y deja de mostrar pendientes al completar', async ({ page }) => {
  let completo = false;
  await page.route('**/v1/onboarding', (r) => r.fulfill({ json: completo ? { ...progreso, completo: true, siguiente: null, pasos: progreso.pasos.map((p) => ({ ...p, hecho: true })) } : progreso }));
  await page.goto('/');
  await expect(page.getByText('Te falta un paso para empezar a atender.')).toBeVisible();
  await expect(page.getByRole('progressbar')).toHaveAttribute('value', '1');
  await expect(page.getByRole('progressbar')).toHaveAttribute('max', '2');
  await expect(page.getByRole('link').filter({ has: page.getByRole('button', { name: 'Hacerlo ahora' }) })).toHaveAttribute('href', '/ajustes/ia');
  completo = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('heading', { name: 'Tu negocio está en marcha' })).toBeVisible();
  await expect(page.getByRole('progressbar')).toHaveCount(0);
});

test('un fallo permite reintentar; el 403 conserva la bienvenida', async ({ page }) => {
  let status = 503;
  await page.route('**/v1/onboarding', (r) => r.fulfill({ status, json: {} }));
  await page.goto('/');
  await expect(page.getByRole('status')).toContainText('No pudimos cargar tu avance');
  status = 403;
  await page.getByRole('button', { name: 'Actualizar avance' }).click();
  await expect(page.getByRole('button', { name: 'Ir a la bandeja' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Actualizar puesta en marcha' })).toHaveCount(0);
});

test('cambiar de negocio descarta el progreso del anterior', async ({ page }) => {
  const segundo = '00000000-0000-4000-8000-000000000298';
  await page.route('**/v1/me', (r) => r.fulfill({ json: { tenants: [
    { tenantId: auth.tenantId, tenantName: 'Negocio inicial', roleName: 'ADMIN' },
    { tenantId: segundo, tenantName: 'Otro negocio', roleName: 'ADMIN' },
  ] } }));
  await page.route('**/v1/onboarding', (r) => r.fulfill({ json: r.request().headers()['x-tenant-id'] === segundo ? { ...progreso, siguiente: 'whatsapp_connected', pasos: progreso.pasos.map((p) => ({ ...p, hecho: p.id === 'configured' })) } : progreso }));
  await page.goto('/');
  await expect(page.getByText('Lo siguiente: cuéntanos de tu negocio.')).toBeVisible();
  await page.getByRole('button', { name: 'Mostrar u ocultar el menú' }).click();
  await page.getByRole('combobox', { name: 'Negocio' }).selectOption(segundo);
  await page.keyboard.press('Escape');
  await expect(page.getByText('Lo siguiente: conecta tu whatsapp.')).toBeVisible();
  await expect(page.getByText('Lo siguiente: cuéntanos de tu negocio.')).toHaveCount(0);
});

for (const modo of ['dia', 'noche']) {
  test(`estado vacío a 360 px en ${modo}, sin desborde y con foco Pulso`, async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 900 });
    await page.route('**/v1/contacts?*', (r) => r.fulfill({ json: { items: [], nextCursor: null } }));
    await page.goto('/contactos');
    const vacio = page.getByRole('region', { name: 'Aquí empieza tu cartera de contactos' });
    await expect(vacio).toBeVisible();
    await page.evaluate((modo) => document.documentElement.setAttribute('data-mode', modo), modo);
    await page.keyboard.press('Tab');
    const accion = vacio.getByRole('link', { name: 'Importar contactos' });
    await accion.focus();
    expect(await accion.evaluate((el) => getComputedStyle(el).outlineWidth)).toBe('2px');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const carpeta = join(__dirname, '../../../docs/evidencias/298');
    mkdirSync(carpeta, { recursive: true });
    await page.screenshot({ path: join(carpeta, `vacio-${modo}-360.png`), fullPage: true });
    await page.route('**/v1/onboarding', (r) => r.fulfill({ json: progreso }));
    await page.goto('/');
    await expect(page.getByRole('progressbar')).toBeVisible();
    await page.evaluate((modo) => document.documentElement.setAttribute('data-mode', modo), modo);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: join(carpeta, `avance-${modo}-360.png`), fullPage: true });
  });
}
