import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * El mensaje se ve apenas se aprieta Enviar (#671).
 *
 * Antes no aparecía hasta que volvían el POST, las SEIS llamadas de
 * `cargarConversacion` —detalle, mensajes, notas, sugerencia del copiloto,
 * análisis y límites de adjunto— y la de la lista. Y la caja ya se había
 * limpiado, así que por un momento lo escrito no estaba en ningún lado: ni en el
 * campo ni en el hilo. Eso es lo que se siente como «no se mandó».
 *
 * La prueba DEMORA la respuesta del servidor a propósito. Sin eso pasaría igual
 * sin el cambio, que es la trampa de las pruebas de esto: en local el servidor
 * contesta tan rápido que no se distingue lo optimista de lo real.
 */
const auth = JSON.parse(readFileSync(join(__dirname, '.auth.json'), 'utf8'));

test.beforeEach(async ({ page }) => {
  const sesion = {
    access_token: auth.accessToken,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: 'e2e',
    user: { id: auth.userId, aud: 'authenticated', email: 'supervisora@e2e.cl' },
  };
  await page.addInitScript(
    ([k, v, t]) => {
      localStorage.setItem(k, v);
      localStorage.setItem('iaxti-tenant', t);
    },
    ['sb-127-auth-token', JSON.stringify(sesion), auth.tenantId] as const,
  );
});

test('se ve al instante, aunque el servidor tarde', async ({ page }) => {
  await page.route('**/v1/conversations/*/messages', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await new Promise((r) => setTimeout(r, 4000));
    await route.fallback();
  });

  await page.goto('/bandeja');
  await page.getByRole('button', { name: /\+56 ?9/ }).first().click();
  const chat = page.getByRole('region', { name: 'Conversación', exact: true });
  await page.getByLabel('Mensaje', { exact: true }).fill('Esto tiene que verse ya');
  await page.getByLabel('Enviar').click();

  // Con el POST demorado 4 s, esto solo pasa si se dibuja sin esperarlo.
  const burbuja = chat.locator('li').filter({ hasText: 'Esto tiene que verse ya' });
  await expect(burbuja.first()).toBeVisible({ timeout: 1500 });
  // Y con su reloj de «en cola», que es el estado real mientras tanto.
  await expect(chat.getByLabel('En cola').last()).toBeVisible();

  // Cuando el servidor contesta, no queda duplicado.
  await expect(burbuja).toHaveCount(1, { timeout: 15_000 });
});

test('si el envío falla, se saca y lo escrito NO se pierde', async ({ page }) => {
  await page.route('**/v1/conversations/*/messages', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await route.fulfill({
      status: 422,
      json: {
        code: 'OUTSIDE_WINDOW',
        message: 'Pasaron más de 24 horas desde su último mensaje: por WhatsApp solo salen plantillas aprobadas.',
        requestId: 'req_prueba',
        details: [],
      },
    });
  });

  await page.goto('/bandeja');
  await page.getByRole('button', { name: /\+56 ?9/ }).first().click();
  const chat = page.getByRole('region', { name: 'Conversación', exact: true });
  await page.getByLabel('Mensaje', { exact: true }).fill('Esto no va a salir');
  await page.getByLabel('Enviar').click();

  // El motivo se lee (#645).
  await expect(page.locator('[data-sonner-toast]').first()).toContainText('24 horas');
  // El optimista se fue: dejarlo con cara de enviado sería peor que no mostrarlo.
  await expect(chat.locator('li').filter({ hasText: 'Esto no va a salir' })).toHaveCount(0);
  // Y lo escrito sigue en la caja, que es lo que #560 fijó.
  await expect(page.getByLabel('Mensaje', { exact: true })).toHaveValue('Esto no va a salir');
});
