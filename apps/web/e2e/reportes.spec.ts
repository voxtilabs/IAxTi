import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Reportes con datos DE VERDAD (#424).
 *
 * `reportes-rendimiento.spec.ts` intercepta la API para poder controlar el
 * orden de las respuestas: prueba el recorrido. Esto prueba lo otro — que
 * con el dashboard real, con sus días y sus huecos, el gráfico salga y se
 * pueda leer. Las dos cosas hacen falta: una respuesta inventada siempre
 * tiene la forma que el test espera.
 *
 * Corre en viewport de celular, que es donde un tooltip no existe: no hay
 * cursor que pasar por encima de un punto.
 */
const auth = JSON.parse(readFileSync(join(__dirname, '.auth.json'), 'utf8'));

test.beforeEach(async ({ page }) => {
  await page.addInitScript((auth) => {
    localStorage.setItem('iaxti-tenant', auth.tableTenantId);
    localStorage.setItem('sb-127-auth-token', JSON.stringify({
      access_token: auth.accessToken, token_type: 'bearer', expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'e2e',
      user: { id: auth.userId, aud: 'authenticated', email: 'reportes@e2e.cl' },
    }));
  }, auth);
});

test('con datos reales el gráfico sale y se puede leer', async ({ page }) => {
  const pedidos: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/v1/analytics/dashboard')) pedidos.push(r.url());
  });
  await page.goto('/reportes');
  await expect(page.getByRole('heading', { name: 'Cómo va el negocio' })).toBeVisible();
  // El rango pedido es el que dice la pestaña: 30 días son 30 días.
  await expect.poll(() => pedidos.length).toBeGreaterThan(0);
  const url = new URL(pedidos[0]);
  const dias =
    (Date.parse(url.searchParams.get('to')!) - Date.parse(url.searchParams.get('from')!)) / 86_400_000 + 1;
  expect(dias).toBe(30);
  // El gráfico existe y dice qué muestra. Con el dashboard real hay días
  // sin ninguna fila en `daily_metrics`, y esos huecos tienen que salir
  // como ceros: una serie que se salta los días vacíos dibuja un mes
  // apretado en una semana.
  const grafico = page.getByRole('img', { name: /Conversaciones nuevas y resueltas por día/ });
  await expect(grafico).toBeVisible();

  // La lectura del día elegido, que es lo que reemplaza al tooltip en un
  // celular: ahí no hay cursor que pasar por encima de un punto.
  // Hay dos gráficos en la pantalla y los dos tienen su lectura: la del de
  // conversaciones es la primera.
  const lectura = page.locator('.pulso-chart-reading').first();
  await expect(lectura).toBeVisible();
  await expect(lectura).toContainText('conversaciones');

  // El detalle por día: la tabla trae los 30 días del rango, no solo los
  // que tuvieron movimiento.
  await page.getByText('Ver datos por día').click();
  const tabla = page.getByRole('table').first();
  await expect(tabla).toBeVisible();
  await expect(tabla.getByRole('row')).toHaveCount(31); // encabezado + 30 días
});

test('en celular, nada se sale de la pantalla', async ({ page }) => {
  await page.goto('/reportes');
  await expect(page.getByRole('heading', { name: 'Cómo va el negocio' })).toBeVisible();
  await page.getByText('Ver datos por día').click();
  const desborde = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(desborde).toBe(false);
});
