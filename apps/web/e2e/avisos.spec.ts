import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Los avisos, probados EN EL NAVEGADOR (#650).
 *
 * Esta prueba existe porque el defecto que la motivó es invisible para una
 * guarda de texto. El código decía:
 *
 *     AvisoResultado({ tono: 'error', children: falta });
 *
 * y leído parece correcto: llama al aviso con su tono y su mensaje. Pero
 * `AvisoResultado` es un COMPONENTE cuyo trabajo entero vive en un `useEffect`,
 * así que llamarlo como función desde un manejador de eventos no muestra nada
 * —y encima lanza «Invalid hook call» (React #321)—. Ninguna revisión de fuente
 * lo iba a cazar; solo verlo correr.
 *
 * Lo que se veía en las diez pantallas que #618 convirtió: apretabas el botón,
 * el cursor saltaba a un campo, ningún mensaje, y una excepción en la consola.
 */

interface Auth {
  accessToken: string;
  userId: string;
  tenantId: string;
}
const auth: Auth = JSON.parse(readFileSync(join(__dirname, '.auth.json'), 'utf8'));

for (const modo of ['dia', 'noche'] as const) {
  test(`el aviso de un formulario incompleto SALE, y sin lanzar (${modo})`, async ({ page }) => {
    const errores: string[] = [];
    page.on('pageerror', (e) => errores.push(String(e)));

    const sesion = {
      access_token: auth.accessToken,
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: 'e2e',
      user: { id: auth.userId, aud: 'authenticated', email: 'supervisora@e2e.cl' },
    };
    await page.addInitScript(
      ([k, v, t, m]) => {
        localStorage.setItem(k, v);
        localStorage.setItem('iaxti-tenant', t);
        localStorage.setItem('iaxti-modo', m);
        document.addEventListener('DOMContentLoaded', () =>
          document.documentElement.setAttribute('data-mode', m),
        );
      },
      ['sb-127-auth-token', JSON.stringify(sesion), auth.tenantId, modo] as const,
    );
    await page.setViewportSize({ width: 1280, height: 860 });
    await page.goto('/ajustes/etiquetas');
    await page.getByRole('button', { name: 'Crear', exact: true }).click();

    // 1 · El aviso se ve, y dice qué falta con el RÓTULO que la persona lee —no
    //     con el nombre del campo, que no le sirve a nadie.
    const aviso = page.locator('[data-sonner-toast]').first();
    await expect(aviso).toBeVisible();
    await expect(aviso).toContainText('Cómo se llama');

    // 2 · Y el foco quedó en el campo que falta: era lo mejor que hacía la
    //     burbuja nativa, y perderlo sería cambiar algo feo por algo peor.
    await expect(page.getByLabel('Cómo se llama')).toBeFocused();

    // 3 · Sin excepciones. Antes salían dos por cada intento.
    expect(errores, `la página lanzó: ${errores.join(' · ')}`).toEqual([]);

    // 4 · El botón de cerrar va a la DERECHA del mensaje. Con `unstyled` viene
    //     primero en el DOM, y sin `order-last` se dibujaba a la izquierda: un
    //     círculo blanco de 46 px, más grande que el texto y antes que él.
    const cerrar = aviso.getByRole('button', { name: 'Cerrar aviso' });
    const cajaAviso = (await aviso.boundingBox())!;
    const cajaCerrar = (await cerrar.boundingBox())!;
    expect(
      cajaCerrar.x,
      'el botón de cerrar volvió a quedar a la izquierda del mensaje',
    ).toBeGreaterThan(cajaAviso.x + cajaAviso.width / 2);

    // 5 · Y conserva el área de toque, aunque ya no tenga cuerpo visible.
    expect(cajaCerrar.width).toBeGreaterThanOrEqual(40);
    expect(cajaCerrar.height).toBeGreaterThanOrEqual(40);

    await page.screenshot({ path: `e2e/capturas/aviso-${modo}.png` });
  });
}
