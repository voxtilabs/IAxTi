import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Una conversación larga se puede recorrer (#1152).
 *
 * La pantalla del asistente nació con `altoCompleto` como prop del shell y
 * sin la clase que acota la altura. Sin ella, el `flex-1` del contenido no
 * tiene contra qué resolverse y crece con lo que hay adentro: medido, el
 * área de la conversación daba 2.222 px en una ventana de 780.
 *
 * El efecto no es «se ve raro»: `clientHeight === scrollHeight`, así que no
 * hay scroll por dentro, y la página tampoco crece porque el shell no
 * scrollea. El hilo quedaba fuera de pantalla y era **inalcanzable**.
 *
 * Por eso se mide el scroll y no la apariencia: una captura de un chat corto
 * se ve perfecta con este defecto puesto.
 */
const auth = JSON.parse(readFileSync(join(__dirname, '.auth.json'), 'utf8'));

for (const [nombre, ancho, alto] of [['escritorio', 1280, 900], ['celular', 390, 780]] as const) {
  test(`en ${nombre}, una conversación larga se recorre`, async ({ page }) => {
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
    await page.route('**/v1/agente-general', (r) =>
      r.fulfill({ json: {
        texto: 'Listo. ' + 'Una respuesta larga para que el hilo crezca de verdad. '.repeat(8),
        pasos: [], propuesta: null, truncada: false,
      } }));

    await page.goto('/ajustes/ia');
    const panel = page.getByRole('region', { name: 'Conversación con IAxTi' });
    for (let i = 1; i <= 5; i++) {
      await panel.getByLabel('Pídele algo a IAxTi').fill(`Pregunta ${i}`);
      await panel.getByRole('button', { name: 'Pedir', exact: true }).click();
      await page.waitForTimeout(500);
    }

    const m = await page.evaluate(() => {
      const log = document.querySelector('[role="log"]') as HTMLElement;
      const scroller = log.querySelector(':scope > *') as HTMLElement;
      const doc = document.documentElement;
      return {
        visible: Math.round(scroller.clientHeight),
        contenido: Math.round(scroller.scrollHeight),
        pagina: { alto: doc.clientHeight, contenido: doc.scrollHeight },
      };
    });

    // Lo que de verdad importa: hay más hilo que pantalla, Y se puede llegar.
    expect(m.contenido, 'la conversación no creció: la prueba no está midiendo nada')
      .toBeGreaterThan(m.visible + 100);
    expect(m.visible, 'el área del chat creció con su contenido en vez de acotarse a la ventana')
      .toBeLessThanOrEqual(alto);
    expect(m.pagina.contenido, 'la página entera crece: el chat empuja el compositor fuera')
      .toBeLessThanOrEqual(m.pagina.alto + 1);

    // Y se recorre de verdad.
    await page.evaluate(() => {
      const s = document.querySelector('[role="log"] > *') as HTMLElement;
      s.scrollTop = s.scrollHeight;
    });
    const arriba = await page.evaluate(() => (document.querySelector('[role="log"] > *') as HTMLElement).scrollTop);
    expect(arriba, 'no se pudo desplazar la conversación').toBeGreaterThan(0);
  });
}
