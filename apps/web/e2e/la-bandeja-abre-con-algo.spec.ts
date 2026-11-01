import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * La bandeja no abre en blanco (#1165).
 *
 * Medido antes: a 1.440 px la lista usaba 440 y los otros ~1.000 quedaban
 * vacíos, con la chuleta de atajos de teclado al medio. Lo primero que veía
 * alguien al abrir la pantalla donde más se trabaja era `j / k`, `e` y
 * `Ctrl+K`.
 *
 * Ningún buzón hace eso —Gmail, Front, Intercom, Superhuman abren la
 * primera—, y la pantalla de tres paneles existe justamente para ver lista,
 * conversación y ficha a la vez.
 *
 * Se mide que haya MENSAJES en el centro y no solo que la selección cambie:
 * marcar la conversación en la lista sin que el panel traiga su hilo deja la
 * misma pantalla vacía con un ítem resaltado.
 */
const auth = JSON.parse(readFileSync(join(__dirname, '.auth.json'), 'utf8'));

async function entrar(page: import('@playwright/test').Page, ancho: number, alto: number) {
  await page.setViewportSize({ width: ancho, height: alto });
  await page.addInitScript((a) => {
    localStorage.setItem('iaxti-tenant', a.tenantId);
    localStorage.setItem('pulso-mode', 'dia');
    localStorage.setItem('sb-127-auth-token', JSON.stringify({
      access_token: a.accessToken, token_type: 'bearer', expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'e2e',
      user: { id: a.userId, aud: 'authenticated', email: 'supervisora@e2e.cl' },
    }));
  }, auth);
  await page.goto('/bandeja', { waitUntil: 'domcontentloaded' });
}

test('en escritorio abre con la primera conversación puesta', async ({ page }) => {
  await entrar(page, 1440, 950);
  // El hilo de verdad, no solo el resaltado en la lista.
  await expect(page.getByText(/me pueden ayudar con una/).nth(1)).toBeVisible({ timeout: 15_000 });
  // Y el compositor, que es lo que dice «acá se contesta».
  await expect(page.getByPlaceholder('Escribe tu respuesta…')).toBeVisible();
});

test('en celular NO: ahí la lista es la pantalla', async ({ page }) => {
  await entrar(page, 390, 844);
  await page.waitForTimeout(3000);
  // Si abriera sola, el compositor estaría puesto y la lista escondida: quien
  // entra quedaría adentro de una conversación que no pidió, con el botón de
  // volver como única salida.
  await expect(page.getByPlaceholder('Escribe tu respuesta…')).toHaveCount(0);
  await expect(page.getByPlaceholder('Buscar en mensajes y notas…')).toBeVisible();
});

test('el panel vacío no enseña atajos de teclado', async ({ page }) => {
  // Con la lista VACÍA, que es la única forma de que ese panel aparezca
  // ahora. Sin vaciarla, la bandeja abre con una conversación puesta y la
  // prueba pasaría sin mirar nada — lo comprobé devolviendo la chuleta a su
  // lugar: seguía verde.
  await page.route('**/v1/conversations**', (r) => r.fulfill({ json: { items: [] } }));
  await entrar(page, 1440, 950);
  await expect(page.getByText(/Elige una conversación/)).toBeVisible({ timeout: 15_000 });
  // La chuleta sigue existiendo detrás del «?»; lo que no puede es estar en
  // el panel central, que es lo primero que mira quien no conoce la pantalla.
  await expect(page.getByText('Siguiente / anterior conversación')).toHaveCount(0);
});
