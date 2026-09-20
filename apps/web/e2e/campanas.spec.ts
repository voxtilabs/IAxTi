import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const auth = JSON.parse(readFileSync(join(__dirname, '.auth.json'), 'utf8'));
test.beforeEach(async ({ page }) => {
  await page.addInitScript((auth) => {
    localStorage.setItem('iaxti-tenant', auth.campaignTenantId);
    localStorage.setItem('sb-127-auth-token', JSON.stringify({
      access_token: auth.accessToken, token_type: 'bearer', expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'e2e',
      user: { id: auth.userId, aud: 'authenticated', email: 'administradora@e2e.cl' },
    }));
  }, auth);
});

async function preparar(page: import('@playwright/test').Page) {
  await page.goto('/campanas');
  await page.getByRole('button', { name: 'Crear campaña', exact: true }).click();
  await page.getByLabel('Nombre de la campaña').fill(`Novedades de prueba ${Date.now()}`);
  await page.getByLabel('Plantilla aprobada').selectOption({ label: 'novedades_aprobada' });
  await expect(page.getByRole('option', { name: 'aun_sin_aprobar' })).toHaveCount(0);
  await page.getByLabel('Valor de la variable').fill('{contacto.nombre}');
  await expect(page.getByRole('button', { name: 'Enviar campaña', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Crear borrador y ver destinatarios' }).click();
  await expect(page.getByText('destinatarios en este momento')).toContainText('2');
  await expect(page.getByText('Ana de prueba', { exact: true })).toBeVisible();
  await expect(page.getByText('Sin consentimiento', { exact: true })).toHaveCount(0);
}

test('crea, revisa y encola por API real; muestra el motivo del destinatario omitido', async ({ page }) => {
  await preparar(page);
  const requests: string[] = [];
  page.on('request', (request) => {
    if (/\/campanas\/[^/]+\/enviar$/.test(request.url()) && request.method() === 'POST') requests.push(request.headers()['idempotency-key']);
  });
  await page.getByRole('button', { name: 'Enviar campaña', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Resultados de la campaña' })).toBeVisible();
  await expect(page.getByText('sin conversación abierta por ese canal')).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(requests[0]).toBeTruthy();
});

test('la calidad roja explica el bloqueo y no envía ninguna solicitud', async ({ page }) => {
  let envios = 0;
  page.on('request', (req) => { if (req.url().endsWith('/enviar')) envios += 1; });
  await page.route('**/v1/channels', (route) => route.fulfill({ json: [{ id: 'w', kind: 'whatsapp', state: 'active', numbers: [{ id: 'n', displayPhone: '+56980001111', quality: 'red' }] }] }));
  await preparar(page);
  await expect(page.getByRole('button', { name: 'Enviar campaña', exact: true })).toBeDisabled();
  await expect(page.getByText('La calidad del número está en rojo.')).toBeVisible();
  expect(envios).toBe(0);
});

test('si la calidad cae mientras se revisa, vuelve a comprobarla y frena el envío', async ({ page }) => {
  await preparar(page);
  let envios = 0;
  page.on('request', (req) => { if (req.url().endsWith('/enviar')) envios += 1; });
  await page.route('**/v1/channels', (route) => route.fulfill({ json: [{ id: 'w', kind: 'whatsapp', state: 'active', numbers: [{ id: 'n', displayPhone: '+56980001111', quality: 'red' }] }] }));
  await page.getByRole('button', { name: 'Enviar campaña', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Enviar campaña', exact: true })).toBeDisabled();
  await expect(page.locator('[data-sonner-toast]')).toContainText('rojo');
  expect(envios).toBe(0);
});

for (const modo of ['dia', 'noche']) {
  test(`vista previa a 360 px en ${modo}, con foco y sin desborde`, async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 900 });
    await preparar(page);
    await page.evaluate((modo) => document.documentElement.setAttribute('data-mode', modo), modo);
    const enviar = page.getByRole('button', { name: 'Enviar campaña', exact: true });
    await expect(enviar).toBeEnabled();
    await page.keyboard.press('Tab');
    await enviar.focus();
    expect(await enviar.evaluate((el) => getComputedStyle(el).outlineWidth)).toBe('2px');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const carpeta = join(__dirname, '../../../docs/evidencias/356');
    mkdirSync(carpeta, { recursive: true });
    await page.screenshot({ path: join(carpeta, `previa-${modo}-360.png`), fullPage: true });
  });
}

test('el plan de solo lectura conserva el listado y explica por qué no permite crear', async ({ page }) => {
  await page.route('**/v1/me/modules/acceso', (route) => route.fulfill({ json: [{ id: 'automations', acceso: 'solo_lectura' }] }));
  await page.goto('/campanas');
  await expect(page.getByRole('button', { name: 'Crear campaña', exact: true })).toBeDisabled();
  await expect(page.getByText('Tu plan permite consultar campañas, pero no crear ni enviar.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Revisar mi plan' })).toBeVisible();
});
