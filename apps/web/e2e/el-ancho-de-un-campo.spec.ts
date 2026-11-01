import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { comoAdmin } from './como-admin';

/**
 * El ancho de un campo promete cuánto se espera que escribas (#1150).
 *
 * Medido a 1440 antes de esto, el campo más ancho de cada pantalla iba de
 * 256 px a 1.022, sin regla. El peor: `recordatorio_hora` —diecisiete
 * caracteres— en una caja de 1.014. El ojo recorre un metro de caja vacía
 * hasta el borde para escribir una palabra.
 *
 * Se mide en el NAVEGADOR y no en la fuente porque lo que importa es el
 * ancho que resulta, no la clase que se escribió: un contenedor angosto
 * puede dejar un campo correcto sin que el campo diga nada, y al revés.
 *
 * Lo que NO afirma: que todos midan lo mismo. Una URL y el nombre de una
 * etapa no esperan lo mismo, y forzar un valor único es el otro extremo del
 * mismo problema. Afirma un TECHO: ningún campo de una línea llega al ancho
 * de un párrafo.
 */
const auth = JSON.parse(readFileSync(join(__dirname, '.auth.json'), 'utf8'));

/** 40rem: el más ancho de la escala. Un campo de una línea no lo pasa. */
const TECHO = 640;

test.use({ viewport: { width: 1440, height: 900 } });

test('ningún campo de una línea llega al ancho de un párrafo', async ({ page }) => {
  await page.addInitScript((a) => {
    localStorage.setItem('iaxti-tenant', a.tenantId);
    localStorage.setItem('pulso-mode', 'dia');
    localStorage.setItem('sb-127-auth-token', JSON.stringify({
      access_token: a.accessToken, token_type: 'bearer', expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'e2e',
      user: { id: a.userId, aud: 'authenticated', email: 'supervisora@e2e.cl' },
    }));
  }, auth);
  await comoAdmin(page, auth);

  const anchos: { pantalla: string; ancho: number; que: string }[] = [];
  for (const ruta of [
    '/ajustes/plantillas', '/ajustes/campos', '/ajustes/etiquetas',
    '/ajustes/embudos', '/ajustes/api', '/ajustes/webhooks',
  ]) {
    await page.goto(ruta, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading').first().waitFor({ timeout: 10_000 }).catch(() => undefined);
    const medidos = await page.evaluate(() =>
      [...document.querySelectorAll('input[type="text"], input:not([type]), input[type="search"]')]
        .map((e) => ({
          ancho: Math.round(e.getBoundingClientRect().width),
          que: (e as HTMLInputElement).placeholder || e.getAttribute('aria-label') || '(sin nombre)',
        }))
        .filter((x) => x.ancho > 0),
    );
    for (const m of medidos) anchos.push({ pantalla: ruta, ...m });
  }

  expect(anchos.length, 'no se midió ningún campo: el barrido no está mirando nada')
    .toBeGreaterThan(4);
  const pasados = anchos.filter((a) => a.ancho > TECHO);
  expect(
    pasados.map((a) => `${a.pantalla} · ${a.ancho}px · «${a.que}»`),
    'un campo de una línea con ancho de párrafo promete un texto largo y recibe una palabra',
  ).toEqual([]);
});
