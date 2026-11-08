import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const auth = JSON.parse(readFileSync(join(__dirname, '.auth.json'), 'utf8'));

/**
 * La tarjeta dice qué hay que hacer y cuándo (#1302).
 *
 * El dueño, mirando el tablero: «las tarjetas dicen poco», «no se puede
 * trabajar desde ahí». El dato estaba en `activities` desde la migración 0003
 * y no lo leía nadie.
 *
 * La fixture deja las cuatro primeras con una pendiente en cada estado y el
 * resto sin nada agendado, que es el estado más común y el que el tablero no
 * sabía nombrar.
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript((auth) => {
    localStorage.setItem('iaxti-tenant', auth.tableTenantId);
    localStorage.setItem('sb-127-auth-token', JSON.stringify({
      access_token: auth.accessToken, token_type: 'bearer', expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'e2e',
      user: { id: auth.userId, aud: 'authenticated', email: 'tablas@e2e.cl' },
    }));
  }, auth);
});

test('el tablero dice de un vistazo cuál está atrasada y cuál no tiene nada', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/oportunidades');
  const columna = page.getByRole('region', { name: 'Etapa Nuevo' });
  await expect(columna).toBeVisible();

  // Los cuatro estados, cada uno con su palabra: el color no puede ser el
  // único portador de significado (SPEC §29).
  await expect(columna.getByText(/^Atrasada \d+ días?$/).first()).toBeVisible();
  await expect(columna.getByText('Vence hoy').first()).toBeVisible();
  await expect(columna.getByText(/^En\s*4\s*días$/).first()).toBeVisible();
  await expect(columna.getByText('Sin fecha').first()).toBeVisible();
  // Y el más común, que es el que faltaba: nadie se está haciendo cargo.
  await expect(columna.getByText('Sin agendar').first()).toBeVisible();

  const folder = join(__dirname, '../../../docs/evidencias/1302');
  mkdirSync(folder, { recursive: true });
  for (const modo of ['dia', 'noche'] as const) {
    await page.evaluate((m) => document.documentElement.setAttribute('data-mode', m), modo);
    await page.screenshot({ path: join(folder, `tablero-${modo}.png`) });
  }
});

test('a 360 px la tarjeta sigue entrando: el estado no empuja el contacto fuera', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('/oportunidades');
  await expect(page.getByRole('region', { name: 'Etapa Nuevo' })).toBeVisible();
  // La página no scrollea de lado. La ranura comparte línea con el contacto,
  // que trunca; si en vez de truncar empujara, esto lo vería.
  const ancho = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(ancho).toBeLessThanOrEqual(361);

  const folder = join(__dirname, '../../../docs/evidencias/1302');
  mkdirSync(folder, { recursive: true });
  for (const modo of ['dia', 'noche'] as const) {
    await page.evaluate((m) => document.documentElement.setAttribute('data-mode', m), modo);
    await page.screenshot({ path: join(folder, `tablero-celular-${modo}.png`), fullPage: true });
  }
});
