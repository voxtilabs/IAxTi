import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * El mensaje aparece al instante, no cuando el servidor termina (#671).
 *
 * Responder tomaba el POST más seis llamadas de recarga, y hasta que volvía la
 * última el chat se veía igual que antes de apretar Enviar. Con el proveedor lento
 * eso son segundos mirando una pantalla que no acusa recibo, y la reacción natural
 * es apretar otra vez.
 *
 * Acá el servidor se demora A PROPÓSITO: es la única forma de comprobar que lo que
 * se ve no depende de él.
 */
const auth = JSON.parse(readFileSync(join(__dirname, '.auth.json'), 'utf8')) as {
  accessToken: string;
  userId: string;
  tenantId: string;
};

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
    ([clave, valor, tenant]) => {
      localStorage.setItem(clave, valor);
      localStorage.setItem('iaxti-tenant', tenant);
    },
    ['sb-127-auth-token', JSON.stringify(sesion), auth.tenantId] as const,
  );
});

test('se ve al instante, aunque el servidor tarde', async ({ page }) => {
  // Tres segundos de demora en el POST. Sin el mensaje optimista, el hilo no
  // muestra nada en ese rato.
  await page.route('**/v1/conversations/*/messages*', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await new Promise((listo) => setTimeout(listo, 3000));
    await route.fallback();
  });

  await page.goto('/bandeja');
  await page.getByRole('button', { name: /\+56 ?9/ }).first().click();
  await expect(page.getByText('¿me pueden ayudar con una cotización?')).toBeVisible();

  const campo = page.getByLabel('Mensaje', { exact: true });
  await campo.fill('Te confirmo en un rato.');
  await page.getByLabel('Enviar').click();

  const chat = page.getByRole('region', { name: 'Conversación' });
  // Al instante, con el POST todavía en vuelo: el mensaje en el hilo...
  await expect(chat.getByText('Te confirmo en un rato.')).toBeVisible({ timeout: 1500 });
  // ...y la caja vacía. Las dos cosas juntas, porque dejar el texto en el campo
  // con el mensaje ya dibujado se ve como si se hubiera escrito dos veces — y así
  // fue la primera versión de esto: `resolved to 2 elements`.
  await expect(campo).toHaveValue('');
});
