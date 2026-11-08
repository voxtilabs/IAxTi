import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const auth = JSON.parse(readFileSync(join(__dirname, '.auth.json'), 'utf8'));

/**
 * Se puede entrar a una oportunidad (#1301).
 *
 * El tablero mostraba tarjetas que no llevaban a ningún lado: la API no tenía
 * una ruta que devolviera UNA oportunidad y el frontend no tenía dónde
 * mostrarla. «Tampoco puedo entrar al deal», dicho por el dueño.
 *
 * Panel y no página: se mira una tarjeta sin perder de vista en qué etapa
 * estaba ni qué hay en las otras columnas.
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript((auth) => {
    localStorage.setItem('iaxti-tenant', auth.tableTenantId);
    localStorage.setItem('sb-127-auth-token', JSON.stringify({
      access_token: auth.accessToken, token_type: 'bearer', expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'e2e',
      user: { id: auth.userId, aud: 'authenticated', email: 'tablas@e2e.cl' },
    }));
  }, auth);
});

test('la tarjeta abre la ficha al lado, con la etapa y lo que pasó', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/oportunidades');
  await expect(page.getByRole('tab', { name: 'Tablero' })).toHaveAttribute('aria-selected', 'true');

  const primera = page.getByRole('button', { name: /^Venta \d+$/ }).first();
  const titulo = await primera.textContent();
  await primera.click();

  const ficha = page.getByRole('complementary', { name: new RegExp(`Oportunidad ${titulo}`) });
  await expect(ficha).toBeVisible();
  // Las tres preguntas que contesta: en qué etapa está, cómo llegó y qué queda.
  await expect(ficha.getByText('Etapa', { exact: true })).toBeVisible();
  await expect(ficha.getByText('Qué pasó', { exact: true })).toBeVisible();
  await expect(ficha.getByText('Pendientes', { exact: true })).toBeVisible();

  // El tablero sigue ahí: es la mitad de para qué sirve un panel.
  await expect(page.getByRole('tab', { name: 'Tablero' })).toBeVisible();

  // Día y noche: la ficha estrena una superficie raised encima del tablero,
  // que es justo donde los dos modos se separan.
  const folder = join(__dirname, '../../../docs/evidencias/1301');
  mkdirSync(folder, { recursive: true });
  for (const modo of ['dia', 'noche'] as const) {
    await page.evaluate((m) => document.documentElement.setAttribute('data-mode', m), modo);
    await page.screenshot({ path: join(folder, `ficha-escritorio-${modo}.png`) });
  }
});

test('se cierra con Escape, que es por donde se entró si fue con teclado', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/oportunidades');
  await page.getByRole('button', { name: /^Venta \d+$/ }).first().click();
  await expect(page.getByRole('complementary', { name: /Oportunidad/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('complementary', { name: /Oportunidad/ })).toHaveCount(0);
});

test('en celular la ficha CUBRE el tablero, y no lo deja sin ancho', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('/oportunidades');
  await page.getByRole('button', { name: /^Venta \d+$/ }).first().click();
  const ficha = page.getByRole('complementary', { name: /Oportunidad/ });
  await expect(ficha).toBeVisible();
  const caja = await ficha.boundingBox();
  // Ocupa el ancho entero: con el panel de 26rem al lado, las columnas
  // quedarían en nada.
  expect(caja!.width).toBeGreaterThan(340);
  // Y la página no scrollea de lado.
  const ancho = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(ancho).toBeLessThanOrEqual(361);

  const folder = join(__dirname, '../../../docs/evidencias/1301');
  mkdirSync(folder, { recursive: true });
  for (const modo of ['dia', 'noche'] as const) {
    await page.evaluate((m) => document.documentElement.setAttribute('data-mode', m), modo);
    await page.screenshot({ path: join(folder, `ficha-celular-${modo}.png`), fullPage: true });
  }
});
