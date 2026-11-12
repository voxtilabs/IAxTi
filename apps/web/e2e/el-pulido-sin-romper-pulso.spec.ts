import { expect, test } from '@playwright/test';
import { comoAdmin } from './como-admin';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * El pulido sin romper Pulso (#1344).
 *
 * Una pasada de unslop (heydamir/unslop, CC BY 4.0) sobre la app encontró
 * señas de plantilla que no venían de Pulso sino de cómo se aplicó: rótulos
 * en versales espaciadas, títulos chicos con tracking negativo que pegaba las
 * palabras («Instagramy Messenger») y un activo marcado cuatro veces. La
 * altura de la barra NO se tocó: 42 px es el control de Pulso (#1108).
 *
 * Lo que se afirma acá es lo que se ve en la pantalla ya pintada —el estilo
 * COMPUTADO—, no las clases: el tracking de un `h3` puede venir de la base,
 * del preset de Tailwind o de una clase suelta, y una guarda de fuente que
 * mire uno solo de esos tres lugares queda verde con el defecto puesto.
 */
interface Auth {
  accessToken: string;
  userId: string;
  tenantId: string;
  tableTenantId: string;
}

const auth: Auth = JSON.parse(readFileSync(join(__dirname, '.auth.json'), 'utf8'));
const evidencias = join(__dirname, '../../..', 'docs/evidencias/1344');

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
  await comoAdmin(page, auth);
  mkdirSync(evidencias, { recursive: true });
});

const PANTALLAS = [
  ['bandeja', '/bandeja'],
  ['contactos', '/contactos'],
  ['canales', '/ajustes/canales'],
  ['asistente', '/ajustes/ia'],
] as const;

for (const modo of ['dia', 'noche'] as const) {
  for (const [nombre, ruta] of PANTALLAS) {
    test(`${ruta}, modo ${modo}: sin versales espaciadas ni títulos apretados`, async ({ page }) => {
      await page.addInitScript((m) => localStorage.setItem('pulso-mode', m), modo);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(ruta);
      await expect(page.locator('html')).toHaveAttribute('data-mode', modo);
      await page.waitForLoadState('networkidle');

      const medido = await page.evaluate(() => {
        const px = (v: string) => (v === 'normal' ? 0 : parseFloat(v));
        const estilo = (sel: string) =>
          [...document.querySelectorAll<HTMLElement>(sel)].map((n) => {
            const c = getComputedStyle(n);
            const r = n.getBoundingClientRect();
            return {
              texto: (n.textContent ?? '').trim().slice(0, 40),
              mayus: c.textTransform,
              tracking: px(c.letterSpacing),
              tamano: parseFloat(c.fontSize),
              peso: Number(c.fontWeight),
              alto: r.height,
              // `sr-only` mide 1 px: no se ve, así que su tracking no importa.
              visible: r.width > 1 && r.height > 1,
            };
          });
        return {
          grupos: estilo('[data-sidebar="group-label"]'),
          contexto: estilo('.pulso-context span'),
          titulos: estilo('h1, h2, h3, h4'),
        };
      });

      for (const g of [...medido.grupos, ...medido.contexto]) {
        expect(g.mayus, `«${g.texto}» sigue en versales`).toBe('none');
        expect(g.tracking, `«${g.texto}» sigue espaciado`).toBe(0);
      }
      for (const t of medido.titulos.filter((x) => x.visible)) {
        // El tracking negativo es para letra grande: bajo 24 px se come el
        // espacio entre palabras de Outfit.
        if (t.tamano < 24) {
          expect(t.tracking, `el título «${t.texto}» (${t.tamano} px) va apretado`).toBeGreaterThanOrEqual(0);
        }
        expect(t.peso, `el título «${t.texto}» pasa de 600`).toBeLessThanOrEqual(600);
      }
      await page.screenshot({ path: join(evidencias, `${nombre}-${modo}.png`) });
    });
  }

  test(`a 360 px, modo ${modo}: la barra sigue siendo para el dedo y nada se sale`, async ({ page }) => {
    await page.addInitScript((m) => localStorage.setItem('pulso-mode', m), modo);
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto('/contactos');
    await page.waitForLoadState('networkidle');
    const ancho = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(ancho, 'hay scroll horizontal a 360 px').toBeLessThanOrEqual(360);
    await page.screenshot({ path: join(evidencias, `contactos-celular-${modo}.png`) });

    await page.getByRole('button', { name: /menú/i }).first().click();
    await expect(page.getByRole('button', { name: /^Ajustes \(/ })).toBeVisible();
    const altos = await page
      .locator('[data-sidebar="menu-button"]')
      .evaluateAll((nodos) => nodos.map((n) => n.getBoundingClientRect().height));
    expect(altos.length, 'la hoja de la barra no se abrió').toBeGreaterThan(0);
    for (const alto of altos) {
      expect(alto, 'en celular la entrada tiene que poder tocarse').toBeGreaterThanOrEqual(42);
    }
    await page.screenshot({ path: join(evidencias, `barra-celular-${modo}.png`) });
  });
}
