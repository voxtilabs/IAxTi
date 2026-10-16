import { expect, test, type Page, type Locator } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// UI con respuestas sintéticas: los contratos HTTP/RLS/proveedor se ejercitan
// por separado en api/tests/canales-meta-74.test.ts. Aquí no sale ningún envío.
const auth = JSON.parse(readFileSync(join(__dirname, '.auth.json'), 'utf8'));
const evidencias = join(__dirname, '../../..', 'docs/evidencias/74');
const opciones = [
  { senderId: 'sender-ficticio-74', kind: 'instagram', name: 'Tienda de prueba' },
  { senderId: 'sender-ficticio-74', kind: 'messenger', name: 'Página de prueba' },
];
async function focoConTab(page: Page, control: Locator) {
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press('Tab');
    if (await control.evaluate((e) => e === document.activeElement)) break;
  }
  await expect(control).toBeFocused();
  const estilo = await control.evaluate((e) => {
    const s = getComputedStyle(e); return { outline: s.outlineStyle, shadow: s.boxShadow };
  });
  expect(estilo.outline !== 'none' || estilo.shadow !== 'none').toBe(true);
  return estilo;
}
for (const modo of ['dia', 'noche']) {
  test(`Canales Meta a 360 px en ${modo}: estados, teclado y conexión`, async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 900 });
    await page.addInitScript(({ auth, modo }) => {
      localStorage.setItem('pulso-mode', modo);
      localStorage.setItem('iaxti-tenant', auth.tableTenantId);
      localStorage.setItem('sb-127-auth-token', JSON.stringify({ access_token: auth.accessToken, token_type: 'bearer', expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'e2e', user: { id: auth.userId, aud: 'authenticated', email: 'canales@e2e.cl' } }));
    }, { auth, modo });
    let liberar!: () => void;
    const espera = new Promise<void>((r) => { liberar = r; });
    let estado = 'carga';
    await page.route('**/v1/channels/conexiones-disponibles', async (route) => {
      if (estado === 'carga') { await espera; }
      if (estado === 'falla') return route.fulfill({ status: 503, json: { code: 'PROVIDER_UNAVAILABLE', message: 'No pudimos comprobar el emisor. Intenta de nuevo.', requestId: 'req_visual_74' } });
      if (estado === 'sin-permiso') return route.fulfill({ status: 403, json: { code: 'PERMISSION_DENIED', message: 'Sin permiso.', requestId: 'req_permiso_74' } });
      return route.fulfill({ json: estado === 'vacio' ? [] : opciones });
    });
    await page.route('**/v1/channels/conectar', async (route) => {
      expect(route.request().postDataJSON()).toEqual({ senderId: opciones[0].senderId, kind: 'instagram' });
      await route.fulfill({ status: 201, json: { id: 'cuenta-ficticia-74', kind: 'instagram', name: 'Tienda de prueba', state: 'active' } });
    });
    await page.route('**/v1/channels/cuenta-ficticia-74/diagnostico', (route) => route.fulfill({ status: 503, json: { code: 'PROVIDER_UNAVAILABLE', message: 'Diagnóstico simulado.', requestId: 'req_diag_74' } }));
    await page.goto('/ajustes/canales');
    await expect(page.locator('html')).toHaveAttribute('data-mode', modo);
    const panel = page.getByRole('region', { name: 'Conectar Instagram y Messenger' });
    await expect(panel.getByRole('status', { name: 'Buscando conexiones' })).toBeVisible();
    mkdirSync(evidencias, { recursive: true });
    const carga = (await panel.boundingBox())!;
    await panel.screenshot({ path: join(evidencias, `conexion-${modo}-carga.png`) });
    estado = 'lista'; liberar();
    const boton = panel.getByRole('button', { name: 'Conectar Instagram' });
    await expect(boton).toBeVisible();
    const lista = (await panel.boundingBox())!;
    const foco = await focoConTab(page, boton);
    await panel.screenshot({ path: join(evidencias, `conexion-${modo}-lista-foco.png`) });
    await page.keyboard.press('Enter');
    await expect(panel.getByRole('button', { name: 'Conectar Instagram' })).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Identificador del contacto para la prueba' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Identificador del contacto para la prueba' }).fill('17841400000000000');
    await page.locator('text=Probar el envío').first().locator('..').screenshot({ path: join(evidencias, `conexion-${modo}-prueba-id.png`) });
    estado = 'vacio'; await page.reload();
    await expect(panel.getByText('No hay conexiones pendientes')).toBeVisible();
    const vacio = (await panel.boundingBox())!;
    await focoConTab(page, panel.getByRole('button', { name: 'Volver a comprobar' }));
    await panel.screenshot({ path: join(evidencias, `conexion-${modo}-vacio.png`) });
    estado = 'falla'; await page.keyboard.press('Enter');
    await expect(panel.getByText('PROVIDER_UNAVAILABLE · req_visual_74')).toBeVisible();
    await focoConTab(page, panel.getByRole('button', { name: 'Reintentar' }));
    await panel.screenshot({ path: join(evidencias, `conexion-${modo}-falla.png`) });
    estado = 'sin-permiso'; await page.keyboard.press('Enter');
    await expect(panel.getByText(/Necesitas permiso/)).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Reintentar' })).toHaveCount(0);
    await panel.screenshot({ path: join(evidencias, `conexion-${modo}-sin-permiso.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    expect(Math.abs(lista.height - carga.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(vacio.height - carga.height)).toBeLessThanOrEqual(1);
    writeFileSync(join(evidencias, `medidas-${modo}.json`), JSON.stringify({ viewport: 360, carga, lista, vacio, foco }, null, 2));
  });
}
