import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * La vista del asistente llega al chat (#1380).
 *
 * Las pruebas de jsdom ya montan `VistaDelAgente` sola; lo que solo se ve acá
 * es el camino entero: la respuesta del API trae `vista`, `estado.tsx` la
 * guarda en el turno, `conversacion.tsx` la carga bajo demanda
 * (`next/dynamic`) y se dibuja bajo la prosa. Y a 360 px, que es donde una
 * tabla de varias columnas puede empujar la página hacia el costado.
 *
 * El proveedor se intercepta: lo que se prueba es la pantalla, no el modelo.
 * Con `CAPTURAS=1` deja además las capturas en día y noche para el PR.
 */
const auth = JSON.parse(readFileSync(join(__dirname, '.auth.json'), 'utf8'));
const DESTINO = join(__dirname, 'capturas');

const VISTA = {
  root: 'z',
  elements: {
    z: { type: 'Zona', props: { titulo: 'Por contestar hoy' }, children: ['m', 't'] },
    m: { type: 'Metrica', props: { rotulo: 'Conversaciones abiertas', valor: 3, detalle: 'dos dentro de la ventana' } },
    t: {
      type: 'Tabla',
      props: {
        columnas: ['Contacto', 'Teléfono', 'Último mensaje'],
        filas: [
          ['María Paz Rojas', '+56 9 1234 5678', '09:42'],
          ['Jorge Muñoz', '+56 9 8765 4321', 'ayer 18:10'],
          ['Ferretería El Clavo', '+56 2 2345 6789', 'ayer 11:03'],
        ],
        mono: [false, true, true],
      },
    },
  },
};

function entrar(modo: 'dia' | 'noche') {
  return async ({ page }: { page: import('@playwright/test').Page }) => {
    await page.addInitScript(
      ([a, m]) => {
        localStorage.setItem('iaxti-tenant', a.tenantId);
        localStorage.setItem('pulso-mode', m);
        localStorage.setItem('sb-127-auth-token', JSON.stringify({
          access_token: a.accessToken, token_type: 'bearer', expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'e2e',
          user: { id: a.userId, aud: 'authenticated', email: 'supervisora@e2e.cl' },
        }));
      },
      [auth, modo] as const,
    );
    await page.route('**/v1/agents/diagnostico', (r) => r.fulfill({ json: { pasos: [], roto: null } }));
    await page.route('**/v1/agente-general', (r) =>
      r.fulfill({
        json: {
          status: 'ok',
          texto: 'Tienes tres conversaciones abiertas. Dos siguen dentro de la ventana de 24 h:',
          pasos: [{ herramienta: 'listar_conversaciones', modulo: 'conversations', metodo: 'GET', ruta: '/conversations', ok: true }],
          propuesta: null,
          vista: VISTA,
          truncada: false,
        },
      }));
  };
}

async function preguntar(page: import('@playwright/test').Page) {
  await page.goto('/ajustes/ia');
  const panel = page.getByRole('region', { name: 'Conversación con IAxTi' });
  await panel.getByLabel('Pídele algo a IAxTi').fill('¿Qué tengo por contestar?');
  await panel.getByRole('button', { name: 'Pedir', exact: true }).click();
  return panel;
}

test.describe('la vista llega al chat', () => {
  test.beforeEach(entrar('dia'));

  test('se dibuja bajo la prosa, con el teléfono en mono', async ({ page }) => {
    const panel = await preguntar(page);
    await expect(panel.getByText('Tienes tres conversaciones abiertas', { exact: false })).toBeVisible();
    await expect(panel.getByText('Por contestar hoy')).toBeVisible();
    const telefono = panel.getByRole('cell', { name: '+56 9 1234 5678' });
    await expect(telefono).toBeVisible();
    await expect(telefono).toHaveClass(/font-mono/);
    await expect(panel.getByRole('cell', { name: 'María Paz Rojas' })).not.toHaveClass(/font-mono/);
    // «Copiar» sigue copiando la prosa: el bloque crudo no está en pantalla.
    await expect(panel.getByText('```vista')).toHaveCount(0);
  });

  test('a 360 px la tabla se desliza sola y la página no', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    const panel = await preguntar(page);
    await expect(panel.getByText('Por contestar hoy')).toBeVisible();
    const desborde = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(desborde, `la página se pasa ${desborde} px hacia el costado`).toBeLessThanOrEqual(0);
  });
});

for (const modo of ['dia', 'noche'] as const) {
  test.describe(`capturas ${modo}`, () => {
    test.skip(!process.env.CAPTURAS, 'solo con CAPTURAS=1');
    test.beforeEach(entrar(modo));

    test(`vista del asistente · ${modo}`, async ({ page }) => {
      mkdirSync(DESTINO, { recursive: true });
      await page.setViewportSize({ width: 1280, height: 900 });
      const panel = await preguntar(page);
      await expect(panel.getByText('Por contestar hoy')).toBeVisible();
      await page.screenshot({ path: join(DESTINO, `vista-asistente-${modo}.png`) });
      await page.setViewportSize({ width: 360, height: 780 });
      await expect(panel.getByText('Por contestar hoy')).toBeVisible();
      await page.screenshot({ path: join(DESTINO, `vista-asistente-360-${modo}.png`) });
    });
  });
}
