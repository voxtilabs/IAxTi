import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const auth = JSON.parse(readFileSync(join(__dirname, '.auth.json'), 'utf8'));

/**
 * El embudo se entiende desde el tablero (#1303).
 *
 * La medición existía desde #695 y se dibujaba solo dentro de Reportes, que
 * se vende con el plan Equipo. El endpoint es de `crm` y pide el mismo
 * permiso que el tablero: quien mira estas columnas ya tenía derecho a esta
 * lectura y no tenía dónde verla.
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

test('el tablero dice sobre cuántas está midiendo', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/oportunidades');
  await expect(page.getByRole('region', { name: 'Etapa Nuevo' })).toBeVisible();

  // Una lectura sin alcance no significa nada: sobre cuántas se mide, y que
  // es desde el principio y no sobre lo que hay en pantalla.
  await expect(page.getByText(/Sobre\s*30\s*,?\s*desde que empezaste/)).toBeVisible();

  // Y la respuesta a la pregunta, en la cabecera de la etapa: por dónde se
  // cae, con su denominador. Es el número BIEN medido — NO la conversión que
  // publica el endpoint, que cuenta las perdidas como avanzadas (#1310) y
  // daría 100 % en un embudo donde se pierde todo.
  const columna = page.getByRole('region', { name: 'Etapa Nuevo' });
  await expect(columna.getByText(/3\s*de\s*30\s*se perdieron acá/)).toBeVisible();
  await expect(columna.getByText(/avanzaron/)).toHaveCount(0);

  // La frase de arriba NO repite lo que ya dice la cabecera: eso fue lo que
  // la hizo pasarse del techo de prosa (#1157) la primera vez.
  await expect(page.getByText(/Se cae más en/)).toHaveCount(0);

  const folder = join(__dirname, '../../../docs/evidencias/1303');
  mkdirSync(folder, { recursive: true });
  for (const modo of ['dia', 'noche'] as const) {
    await page.evaluate((m) => document.documentElement.setAttribute('data-mode', m), modo);
    await page.screenshot({ path: join(folder, `embudo-${modo}.png`) });
  }
});

test('a 360 px la lectura no se come el tablero', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('/oportunidades');
  const columna = page.getByRole('region', { name: 'Etapa Nuevo' });
  await expect(columna).toBeVisible();
  // La columna tiene que seguir teniendo alto para trabajar: si la frase se
  // comiera el tablero, esto lo vería.
  const caja = await columna.boundingBox();
  expect(caja!.height).toBeGreaterThan(400);
  const ancho = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(ancho).toBeLessThanOrEqual(361);

  const folder = join(__dirname, '../../../docs/evidencias/1303');
  mkdirSync(folder, { recursive: true });
  await page.screenshot({ path: join(folder, 'embudo-celular.png'), fullPage: true });
});
