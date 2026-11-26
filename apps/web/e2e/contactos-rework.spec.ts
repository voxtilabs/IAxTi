import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Contactos (#1395), en la pantalla real y contra la API de verdad: agregar
 * a alguien a mano, encontrarlo con los filtros y abrir su ficha. Con
 * `CAPTURAS=1` deja día y noche, en escritorio y celular.
 */
const auth = JSON.parse(readFileSync(join(__dirname, '.auth.json'), 'utf8'));
const DESTINO = join(__dirname, '..', '..', '..', 'docs', 'evidencias', '1395');

for (const [modo, ancho, alto] of [['dia', 1280, 900], ['noche', 1280, 900], ['dia', 390, 844], ['noche', 390, 844]] as const) {
  test(`agregar, filtrar y abrir un contacto · ${modo} · ${ancho}`, async ({ page }) => {
    await page.setViewportSize({ width: ancho, height: alto });
    await page.addInitScript(
      ([a, m]) => {
        localStorage.setItem('iaxti-tenant', a.campaignTenantId);
        localStorage.setItem('pulso-mode', m);
        localStorage.setItem('sb-127-auth-token', JSON.stringify({
          access_token: a.accessToken, token_type: 'bearer', expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'e2e',
          user: { id: a.userId, aud: 'authenticated', email: 'supervisora@e2e.cl' },
        }));
      },
      [auth, modo] as const,
    );
    // Un teléfono distinto por corrida: el índice único no deja repetirlo.
    const telefono = `+5698${String(Date.now()).slice(-7)}`;
    const nombre = `Rosa ${modo} ${ancho}`;

    await page.goto('/contactos');
    await page.getByRole('button', { name: 'Nuevo contacto' }).click();
    const dialogo = page.getByRole('dialog');
    await dialogo.getByLabel('Teléfono').fill(telefono);
    await dialogo.getByLabel('Nombre').fill(nombre);
    await dialogo.getByRole('button', { name: 'Agregar contacto' }).click();
    await expect(dialogo).toBeHidden();

    // Agregada a mano: aparece al filtrar «Sin permiso», con su canal.
    await page.getByRole('combobox', { name: 'Permiso' }).click();
    await page.getByRole('option', { name: 'Sin permiso' }).click();
    const fila = page.getByRole('row').filter({ hasText: nombre });
    await expect(fila).toBeVisible();
    if (ancho > 600) await expect(fila.getByText('Agregado a mano')).toBeVisible();
    if (process.env.CAPTURAS) {
      mkdirSync(DESTINO, { recursive: true });
      await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
      await page.screenshot({ path: join(DESTINO, `lista-${modo}-${ancho}.png`) });
    }

    await fila.getByRole('link', { name: new RegExp(nombre) }).click();
    await expect(page.getByRole('heading', { name: nombre })).toBeVisible();
    await expect(page.getByText('Sin permiso').first()).toBeVisible();
    if (process.env.CAPTURAS) {
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(DESTINO, `ficha-${modo}-${ancho}.png`), fullPage: true });
    }
  });
}
