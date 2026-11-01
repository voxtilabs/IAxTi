import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Abrir «Tu asistente» tiene que sentirse como abrir un chat (#1163).
 *
 * El pedido del dueño fue literal: «que sea literalmente como abrir chatgpt o
 * claude web». #1135 sacó los cinco bloques de configuración, que era lo
 * gordo, y quedó lo fino: el nombre de la pantalla aparecía CUATRO veces en
 * los primeros 300 px —en la barra lateral resaltado, en la miga del topbar,
 * en el rótulo y en el título— y entre el borde de arriba y el primer mensaje
 * había 430 px de cosas que no eran la conversación.
 *
 * Se mide el alto hasta el primer turno y no la apariencia: una captura con
 * un hilo largo se ve bien igual, porque lo que sobra queda arriba del
 * scroll. El defecto solo se nota al abrirla.
 */
const auth = JSON.parse(readFileSync(join(__dirname, '.auth.json'), 'utf8'));

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
  // Con la IA configurada: la señal de que no puede trabajar se queda a
  // propósito (#614) y ocupa su espacio, pero no es el caso normal.
  await page.route('**/v1/agents/diagnostico', (r) => r.fulfill({ json: { pasos: [], roto: null } }));
  await page.route('**/v1/agente-general', (r) =>
    r.fulfill({ json: { texto: 'Listo.', pasos: [], propuesta: null, truncada: false } }));
});

test('entre el borde de arriba y el primer mensaje hay menos de 200 px', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/ajustes/ia');
  const panel = page.getByRole('region', { name: 'Conversación con IAxTi' });
  await panel.getByLabel('Pídele algo a IAxTi').fill('Hola');
  await panel.getByRole('button', { name: 'Pedir', exact: true }).click();
  const turno = page.getByText('Hola', { exact: true }).first();
  await expect(turno).toBeVisible();

  const arriba = await page.evaluate(() => {
    const main = document.querySelector('main') ?? document.body;
    return main.getBoundingClientRect().top;
  });
  const y = (await turno.boundingBox())!.y;
  const antes = Math.round(y - arriba);
  expect(antes, `hay ${antes} px antes del primer mensaje`).toBeLessThan(200);
});

test('sigue teniendo un solo h1 y sigue diciendo cómo se llama', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/ajustes/ia');
  // El `h1` es `sr-only`: la pantalla tiene nombre para quien no la ve, y el
  // nombre visible lo pone la miga del topbar, igual que en todas las demás.
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tu asistente');
});

test('la conversación no vive dentro de una tarjeta', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/ajustes/ia');
  const marco = await page.getByRole('region', { name: 'Conversación con IAxTi' }).evaluate((el) => {
    const s = getComputedStyle(el);
    return { borde: s.borderTopWidth, fondo: s.backgroundColor };
  });
  expect(marco.borde, 'la conversación volvió a tener borde').toBe('0px');
  // `rgba(0, 0, 0, 0)` es «sin fondo»: el hilo se apoya en la pantalla.
  expect(marco.fondo, 'la conversación volvió a tener fondo propio').toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
});
