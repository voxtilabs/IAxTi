import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Cuando algo falla, la pantalla tiene que dar CON QUÉ pedir ayuda (#659).
 *
 * La API manda el `requestId` en toda respuesta de error y `apiFetch` lo
 * descartaba, así que la pantalla decía «ya quedó registrado» y no daba nada.
 * Quien atiende quedaba sin nada que pasarle a quien puede mirar los registros.
 *
 * Y desde el celular —que es donde se usa la bandeja— no hay consola del
 * navegador donde ir a buscarlo: la única forma era F12 → Network → Response, y
 * eso no existe en un teléfono. Por eso va con su botón de copiar y no solo
 * escrito: seleccionar texto chico con el dedo no es una opción.
 */

const auth = JSON.parse(readFileSync(join(__dirname, '.auth.json'), 'utf8'));

test('un error de la API muestra su identificador y se puede copiar', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
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

  // El 500 con el formato único, tal como lo arma `errors.filter.ts`.
  await page.route('**/v1/conversations/*/messages', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await route.fulfill({
      status: 500,
      json: {
        code: 'INTERNAL',
        message: 'Algo falló de nuestro lado. Ya quedó registrado; intenta de nuevo en un momento.',
        requestId: 'req_de_prueba_1234',
        details: [],
      },
    });
  });

  await page.goto('/bandeja');
  await page.getByRole('button', { name: /\+56 ?9/ }).first().click();
  await page.getByLabel('Mensaje', { exact: true }).fill('esto va a fallar');
  await page.getByLabel('Enviar').click();

  // El aviso sale en el toast: `AvisoResultado` sin `persistente` no dibuja nada
  // en la pantalla, lo levanta ahí. Es donde la persona lo va a leer.
  const aviso = page.locator('[data-sonner-toast]').first();
  // La frase, en la voz de Pulso.
  await expect(aviso).toContainText('Algo falló de nuestro lado');
  // Y el identificador, que es lo que faltaba.
  await expect(aviso).toContainText('req_de_prueba_1234');

  await aviso.getByRole('button', { name: 'Copiar', exact: true }).click();
  const copiado = await page.evaluate(() => navigator.clipboard.readText());
  expect(copiado).toContain('req_de_prueba_1234');
  // El código también: sin él, el identificador solo no dice qué falló.
  expect(copiado).toContain('INTERNAL');
});
