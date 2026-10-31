import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * El popup y la pantalla son LA MISMA conversación (#1129).
 *
 * ADR-0025 hace del Agente General «la vía de configuración universal», y la
 * pantalla «Tu asistente» tiene que SER esa conversación en vez de
 * mencionarla. En cuanto hay dos superficies, la pregunta que importa es si
 * son dos chats o uno: dos asistentes con dos memorias es un enredo que no se
 * nota al construirlo y no se puede deshacer después.
 *
 * Por eso la prueba no mira que el chat «aparezca»: escribe en uno y lee en el
 * otro.
 */
const auth = JSON.parse(readFileSync(join(__dirname, '.auth.json'), 'utf8'));

test.use({ viewport: { width: 1280, height: 900 } });

test.beforeEach(async ({ page }) => {
  await page.addInitScript((a) => {
    localStorage.setItem('iaxti-tenant', a.tenantId);
    localStorage.setItem('pulso-mode', 'dia');
    localStorage.setItem('sb-127-auth-token', JSON.stringify({
      access_token: a.accessToken, token_type: 'bearer', expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'e2e',
      user: { id: a.userId, aud: 'authenticated', email: 'supervisora@e2e.cl' },
    }));
  }, auth);
  await page.route('**/v1/agente-general', (r) => r.fulfill({
    json: { texto: 'Lo dejé anotado.', pasos: [], propuesta: null, truncada: false },
  }));
});

test('lo hablado en la pantalla sigue en el popup, y al revés', async ({ page }) => {
  await page.goto('/ajustes/ia');
  const panel = page.getByRole('region', { name: 'Conversación con IAxTi' });
  await expect(panel).toBeVisible();

  await panel.getByLabel('Pídele algo a IAxTi').fill('Quiero que agende visitas');
  await panel.getByRole('button', { name: 'Pedir' }).click();
  await expect(panel.getByText('Lo dejé anotado.')).toBeVisible();

  // El popup, desde la misma pantalla: tiene que traer lo ya hablado.
  await page.getByRole('button', { name: 'Pedirle algo a IAxTi' }).click();
  const popup = page.getByRole('dialog');
  await expect(popup.getByText('Quiero que agende visitas')).toBeVisible();
  await expect(popup.getByText('Lo dejé anotado.')).toBeVisible();
});

test('navegar a otra pantalla no borra la conversación', async ({ page }) => {
  await page.goto('/ajustes/ia');
  const panel = page.getByRole('region', { name: 'Conversación con IAxTi' });
  await panel.getByLabel('Pídele algo a IAxTi').fill('Armá mis embudos');
  await panel.getByRole('button', { name: 'Pedir' }).click();
  await expect(panel.getByText('Lo dejé anotado.')).toBeVisible();

  // Por la barra, que es navegación de cliente: el proveedor no se desmonta.
  await page.getByRole('link', { name: 'Contactos', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Contactos' })).toBeVisible();
  await page.getByRole('button', { name: 'Pedirle algo a IAxTi' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog').getByText('Armá mis embudos')).toBeVisible();
});

test('cambiar de negocio SÍ corta el hilo: lo hablado era de ese negocio', async ({ page }) => {
  // El invariante que el arreglo de arriba podía romper. Comparar el id en vez
  // de confiar en el evento no puede significar «ya no se corta nunca»:
  // seguir la conversación con otro negocio sería configurarlo con el
  // contexto ajeno, que es peor que perder el hilo.
  await page.goto('/ajustes/ia');
  const panel = page.getByRole('region', { name: 'Conversación con IAxTi' });
  await panel.getByLabel('Pídele algo a IAxTi').fill('Esto es del primer negocio');
  await panel.getByRole('button', { name: 'Pedir' }).click();
  await expect(panel.getByText('Lo dejé anotado.')).toBeVisible();

  // Por el mismo camino que el selector: guarda y avisa.
  await page.evaluate((otro) => {
    localStorage.setItem('iaxti-tenant', otro);
    window.dispatchEvent(new Event('iaxti-tenant-changed'));
  }, auth.tableTenantId);

  await expect(panel.getByText('Esto es del primer negocio')).toHaveCount(0);
  await expect(panel.getByText('Lo dejé anotado.')).toHaveCount(0);
});
