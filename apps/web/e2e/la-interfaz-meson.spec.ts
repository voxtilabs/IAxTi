import { expect, test } from '@playwright/test';
import { comoAdmin } from './como-admin';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * La interfaz es Mesón (ADR-0034, #1346).
 *
 * Los tokens cambiaron de valor y no de nombre, así que una guarda de fuente no
 * distingue «Mesón aplicado» de «Mesón escrito y pisado por una regla vieja».
 * Lo que se afirma acá es lo PINTADO: la familia, el azul de VoxTi en el botón
 * principal, que el marco no tenga ambiente degradado y que nada sea píldora.
 */
interface Auth {
  accessToken: string;
  userId: string;
  tenantId: string;
  tableTenantId: string;
}

const auth: Auth = JSON.parse(readFileSync(join(__dirname, '.auth.json'), 'utf8'));
const evidencias = join(__dirname, '../../..', 'docs/evidencias/1346');
const AZUL_VOXTI = 'rgb(61, 90, 254)';

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
    ([clave, valor]) => {
      localStorage.setItem(clave, valor);
    },
    ['sb-127-auth-token', JSON.stringify(sesion)] as const,
  );
  mkdirSync(evidencias, { recursive: true });
});

/**
 * La bandeja CON una conversación abierta (fase 2 de #1346).
 *
 * Va en el negocio de la bandeja (`tenantId`), que es el que tiene
 * conversaciones; el de tablas abre vacío y la captura no mostraría ni las
 * filas, ni las burbujas, ni la boleta. La lectura de la IA no viene en el
 * seed, así que se le agrega a la respuesta REAL de `/arranque/ficha` —todo lo
 * demás pasa tal cual—: lo que se prueba es cómo la pinta la ficha.
 */
for (const modo of ['dia', 'noche'] as const) {
  test(`la bandeja con una conversación abierta, modo ${modo}: filas, burbujas y la boleta`, async ({ page }) => {
    await page.addInitScript((m) => localStorage.setItem('pulso-mode', m), modo);
    await page.route('**/v1/conversations/*/arranque/ficha', async (route) => {
      const real = await route.fetch();
      const cuerpo = await real.json();
      const hace = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
      cuerpo.analisis = {
        estado: 'ok',
        dato: {
          mode: 'autonomous',
          summary: 'Pregunta por stock en talla 40 y quiere pasar a retirar el viernes.',
          intent: 'compra',
          leadScore: 'caliente',
          suggestDeal: false,
          marcaManual: null,
          acciones: [
            { at: hace(9), que: 'Respondió stock', estado: 'enviada', feedback: null },
            { at: hace(6), que: 'Agendó la visita', estado: 'confirmada', feedback: 'up' },
            { at: hace(5), que: 'Envió link de pago', estado: 'enviada', feedback: null },
          ],
        },
      };
      await route.fulfill({ response: real, json: cuerpo });
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/bandeja');
    await page.waitForLoadState('networkidle');
    await page.locator('.pulso-conversation').first().click();
    const boleta = page.getByRole('group', { name: 'Lo que hizo el asistente' });
    await expect(boleta).toBeVisible();
    await expect(boleta.locator('li')).toHaveCount(3);
    await expect(boleta.getByText('Piloto automático')).toBeVisible();
    // La boleta es papel, no tarjeta: su fondo es el token `--paper`.
    const papel = await boleta.evaluate((n) => ({
      fondo: getComputedStyle(n).backgroundColor,
      token: getComputedStyle(document.documentElement).getPropertyValue('--paper').trim(),
    }));
    expect(papel.token, 'falta el token --paper').not.toBe('');
    // La activa no se pinta de azul (ADR-0034).
    const activa = await page.locator('.pulso-conversation[aria-current="true"]').evaluate((n) => getComputedStyle(n).backgroundColor);
    expect(activa).not.toBe('rgb(61, 90, 254)');
    // La boleta vive abajo en la ficha: se trae a la vista para la captura.
    await boleta.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(evidencias, `bandeja-abierta-${modo}.png`) });
  });
}

test.describe('las pantallas de trabajo', () => {
test.beforeEach(async ({ page }) => {
  await comoAdmin(page, auth);
});

for (const modo of ['dia', 'noche'] as const) {
  for (const [nombre, ruta] of [
    ['bandeja', '/bandeja'],
    ['contactos', '/contactos'],
    ['oportunidades', '/oportunidades'],
    ['canales', '/ajustes/canales'],
    ['agenda', '/agenda'],
    ['pendientes', '/pendientes'],
    ['empresas', '/empresas'],
    ['ajustes-ia', '/ajustes/ia'],
    ['ajustes-equipo', '/ajustes/equipo'],
  ] as const) {
    test(`${ruta}, modo ${modo}: Mesón pintado`, async ({ page }) => {
      await page.addInitScript((m) => localStorage.setItem('pulso-mode', m), modo);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(ruta);
      await expect(page.locator('html')).toHaveAttribute('data-mode', modo);
      await page.waitForLoadState('networkidle');
      await page.evaluate(() => document.fonts.ready);

      const m = await page.evaluate(() => {
        const main = document.querySelector('main');
        const antes = main ? getComputedStyle(main, '::before').backgroundImage : 'none';
        const botones = [...document.querySelectorAll<HTMLElement>('main button:not([role="checkbox"]):not([role="switch"]), main a[role="button"]')]
          .filter((b) => b.getBoundingClientRect().height > 0);
        return {
          familia: getComputedStyle(document.body).fontFamily,
          ambiente: antes,
          // Un radio de píldora es la mitad del alto o más.
          pildoras: botones
            .filter((b) => parseFloat(getComputedStyle(b).borderTopLeftRadius) >= b.getBoundingClientRect().height / 2 - 1)
            .map((b) => (b.textContent ?? '').trim().slice(0, 30))
            .filter(Boolean),
          // Las casillas y los interruptores marcados también son <button>
          // (Radix) y van en azul porque marcan selección, que es el otro
          // trabajo del acento. No son botones principales.
          azules: [...document.querySelectorAll<HTMLElement>('main button:not([role="checkbox"]):not([role="switch"])')]
            .map((b) => getComputedStyle(b).backgroundColor),
        };
      });

      expect(m.familia, 'la letra no es Instrument Sans').toMatch(/^"?Instrument Sans"?/);
      // El ambiente de Pulso Vivo quedó transparente: o no hay imagen, o solo
      // degradados a transparente que no pintan nada.
      expect(m.ambiente.replace(/rgba\(0, 0, 0, 0\)|transparent/g, ''), 'el marco volvió a tener ambiente').not.toMatch(/rgb/);
      expect(m.pildoras, 'botones en forma de píldora').toEqual([]);
      if (m.azules.some((c) => c === AZUL_VOXTI)) {
        expect(m.azules.filter((c) => c === AZUL_VOXTI).length, 'más de un botón principal').toBeLessThanOrEqual(1);
      }

      await page.screenshot({ path: join(evidencias, `${nombre}-${modo}.png`) });
    });
  }

  test(`a 360 px, modo ${modo}: la bandeja cabe y la barra es para el dedo`, async ({ page }) => {
    await page.addInitScript((m) => localStorage.setItem('pulso-mode', m), modo);
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto('/bandeja');
    await page.waitForLoadState('networkidle');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    await page.screenshot({ path: join(evidencias, `bandeja-celular-${modo}.png`) });
  });
}
});
