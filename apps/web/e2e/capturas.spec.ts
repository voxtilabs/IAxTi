import { test } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Capturas del shell en día y noche (#295).
 *
 * Apagado por defecto: el e2e de CI es el criterio de salida de la Fase 2 y
 * no tiene por qué cargar con esto. Se corre a mano con
 * `CAPTURAS=1 node apps/web/e2e/run-e2e.mjs`, y las deja en
 * `apps/web/e2e/capturas/`.
 */
interface Auth {
  accessToken: string;
  userId: string;
  tenantId: string;
}

const auth: Auth = JSON.parse(readFileSync(join(__dirname, '.auth.json'), 'utf8'));
const DESTINO = join(__dirname, 'capturas');

test.skip(!process.env.CAPTURAS, 'solo con CAPTURAS=1');

test.use({ viewport: { width: 1280, height: 900 } });

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
    ([clave, valor, tenant]) => {
      localStorage.setItem(clave, valor);
      localStorage.setItem('iaxti-tenant', tenant);
    },
    ['sb-127-auth-token', JSON.stringify(sesion), auth.tenantId] as const,
  );
  mkdirSync(DESTINO, { recursive: true });
});

for (const modo of ['dia', 'noche'] as const) {
  test(`el shell con barra lateral, modo ${modo}`, async ({ page }) => {
    // La clave es `pulso-mode` y la lee el script inline del <head> ANTES
    // del primer render. Poner el atributo a mano no basta: el script se
    // ejecuta después y lo pisa con lo que diga localStorage.
    await page.addInitScript((m) => {
      localStorage.setItem('pulso-mode', m);
    }, modo);
    await page.goto('/contactos');
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: join(DESTINO, `shell-${modo}.png`), fullPage: false });
  });
}

test('a 360 px la barra se abre como hoja', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/contactos');
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: join(DESTINO, 'shell-celular-cerrado.png') });
  await page.getByRole('button', { name: /menú/i }).first().click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(DESTINO, 'shell-celular-abierto.png') });
});

for (const modo of ['dia', 'noche'] as const) {
  test(`ajustes agrupados en secciones, modo ${modo}`, async ({ page }) => {
    await page.addInitScript((m) => localStorage.setItem('pulso-mode', m), modo);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/ajustes/canales');
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: join(DESTINO, `ajustes-${modo}.png`) });
  });
}
