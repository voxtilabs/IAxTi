import { expect, test } from '@playwright/test';
import { comoAdmin } from './como-admin';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * La navegación dice la verdad (#1324, fase 2 de #1322).
 *
 * Lo que se afirman acá son las DOS cosas que el issue pidió como criterio:
 * el ORDEN de los grupos —Trabajo · Clientes · Asistente · Resultados ·
 * Ajustes— y que «Tu asistente» aparece UNA sola vez en la barra. Lo demás
 * son capturas a 1440 px en día y noche y a 360 px con la hoja abierta,
 * porque la barra es de las cosas que se miran y no se leen.
 *
 * Se entra como ADMIN del negocio de tablas: es el que tiene MÁS entradas
 * (#1142) y el único que ve las tres pantallas de la sección Asistente —
 * Conocimiento y Automatizaciones piden `knowledge.manage` y
 * `automations.manage`, que un SUPERVISOR no tiene. Con menos entradas las
 * pestañas de la sección no se dibujan (es una, no dos) y la captura no
 * mostraría lo que el issue vino a arreglar.
 */
interface Auth {
  accessToken: string;
  userId: string;
  tenantId: string;
  /** El negocio donde la usuaria es ADMIN: el que tiene MÁS entradas (#1142). */
  tableTenantId: string;
}

const auth: Auth = JSON.parse(readFileSync(join(__dirname, '.auth.json'), 'utf8'));
const evidencias = join(__dirname, '../../..', 'docs/evidencias/1324');

/** El orden decidido en #1324, escrito una vez y afirmado en cada pantalla. */
const GRUPOS = ['Trabajo', 'Clientes', 'Asistente', 'Resultados', 'Ajustes'];

/**
 * Los rótulos de grupo de la barra, en el orden del DOM.
 *
 * El plegable trae el conteo pegado —«Ajustes (4)»— así que se le quita; lo
 * que se afirma es el ORDEN y no cuántas pantallas hay detrás.
 */
async function gruposDeLaBarra(page: import('@playwright/test').Page): Promise<string[]> {
  return page.locator('[data-sidebar="group-label"]').evaluateAll((nodos) =>
    nodos.map((n) => (n.textContent ?? '').trim().replace(/\s*\(\d+\)$/, '')),
  );
}

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

test.describe('la barra lateral a 1440 px', () => {
  for (const modo of ['dia', 'noche'] as const) {
    for (const [nombre, ruta] of [
      ['bandeja', '/bandeja'],
      ['asistente', '/ajustes/ia'],
    ] as const) {
      test(`en ${ruta}, modo ${modo}: el orden y una sola entrada de asistente`, async ({ page }) => {
        // La clave es `pulso-mode` y la lee el script inline del <head> ANTES
        // del primer render: poner el atributo a mano no basta, el script se
        // ejecuta después y lo pisa.
        await page.addInitScript((m) => localStorage.setItem('pulso-mode', m), modo);
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(ruta);
        await expect(page.locator('html')).toHaveAttribute('data-mode', modo);
        await page.waitForLoadState('networkidle');

        // El orden de #1324, no el que traiga el catálogo: es decisión de la
        // interfaz y vive en `ORDEN` del shell.
        const grupos = await gruposDeLaBarra(page);
        expect(
          grupos,
          'El orden de los grupos no es el de #1324 (Trabajo · Clientes · ' +
            'Asistente · Resultados · Ajustes).',
        ).toEqual(GRUPOS);

        // «Tu asistente» UNA sola entrada (#1324): el chat, el conocimiento y
        // las automatizaciones viven adentro, como pestañas — se cuentan las
        // de la BARRA y no las de la página, que el tab de la sección es otro
        // enlace con el mismo nombre y no es una segunda entrada del menú.
        const entradas = await page
          .locator('[data-sidebar="menu-button"]')
          .evaluateAll((nodos) => nodos.map((n) => (n.textContent ?? '').trim()));
        const asistente = entradas.filter((t) => t === 'Tu asistente');
        expect(
          asistente.length,
          '«Tu asistente» aparece más de una vez en la barra: el asistente volvió ' +
            'a quedar partido en dos casas (#1324).',
        ).toBe(1);

        await page.screenshot({ path: join(evidencias, `barra-${nombre}-${modo}.png`) });
      });
    }
  }

  for (const modo of ['dia', 'noche'] as const) {
    test(`las pestañas de la sección Asistente, en /ajustes/ia, modo ${modo}`, async ({ page }) => {
      await page.addInitScript((m) => localStorage.setItem('pulso-mode', m), modo);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto('/ajustes/ia');
      await page.waitForLoadState('networkidle');
      // Las tres pantallas de la sección comparten pestañas (#387), y la del
      // chat las muestra también: es lo que hace que buscar «dónde configuro
      // la IA» tenga UNA respuesta (#1324).
      const pestañas = page.getByRole('navigation', { name: 'Ajustes de Asistente' });
      await expect(pestañas).toBeVisible();
      await expect(
        pestañas.getByRole('link', { name: 'Tu asistente', exact: true }),
      ).toBeVisible();
      // El negocio de tablas no tiene el plan de Conocimiento ni el de
      // Automatizaciones, así que las pestañas salen con candado — el nombre
      // accesible pasa a ser «… incluido en un plan superior» (SPEC §6: el
      // candado no esconde, avisa). El patrón deja pasar las dos versiones
      // para que esta prueba no dependa del plan del tenant de ensayo.
      await expect(pestañas.getByRole('link', { name: /^Conocimiento\b/ })).toBeVisible();
      await expect(
        pestañas.getByRole('link', { name: /^Automatizaciones\b/ }),
      ).toBeVisible();
      await page.screenshot({ path: join(evidencias, `pestanas-asistente-${modo}.png`) });
    });
  }
});

test.describe('la barra lateral a 360 px', () => {
  for (const modo of ['dia', 'noche'] as const) {
    test(`abierta como hoja, modo ${modo}`, async ({ page }) => {
      await page.addInitScript((m) => localStorage.setItem('pulso-mode', m), modo);
      await page.setViewportSize({ width: 360, height: 780 });
      await page.goto('/bandeja');
      // En celular la barra está fuera de pantalla: sin el botón que la abre
      // no hay forma de llegar al menú. El `.first()` porque el rótulo del
      // disparador puede venir en más de un control del encabezado.
      const abrir = page.getByRole('button', { name: /menú/i }).first();
      await expect(abrir).toBeVisible();
      await abrir.click();
      await expect(page.getByRole('button', { name: /^Ajustes \(/ })).toBeVisible();

      const grupos = await gruposDeLaBarra(page);
      expect(grupos).toEqual(GRUPOS);
      const entradas = await page
        .locator('[data-sidebar="menu-button"]')
        .evaluateAll((nodos) => nodos.map((n) => (n.textContent ?? '').trim()));
      expect(entradas.filter((t) => t === 'Tu asistente').length).toBe(1);

      await page.screenshot({ path: join(evidencias, `barra-celular-${modo}.png`) });
    });
  }
});