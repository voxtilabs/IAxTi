import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * La pantalla de avisos en el celular (#1410): cada aviso con sus canales
 * nombrados y NADA cortado — la tabla escondía la columna de WhatsApp entera.
 */
const auth = JSON.parse(readFileSync(join(__dirname, '.auth.json'), 'utf8'));

test('los avisos a 390 px: los cuatro canales con nombre y sin scroll', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript((a) => {
    localStorage.setItem('iaxti-tenant', a.campaignTenantId);
    localStorage.setItem('sb-127-auth-token', JSON.stringify({
      access_token: a.accessToken, token_type: 'bearer', expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'e2e',
      user: { id: a.userId, aud: 'authenticated', email: 'supervisora@e2e.cl' },
    }));
  }, auth);
  await page.goto('/ajustes/notificaciones');
  const aviso = page.getByText('Conversación nueva sin dueño').locator('..').locator('..');
  await expect(aviso.getByText('Aviso')).toBeVisible();
  await expect(aviso.getByText('Correo')).toBeVisible();
  await expect(aviso.getByText('Celular')).toBeVisible();
  await expect(aviso.getByText('WhatsApp')).toBeVisible();
  // La columna cortada ya no existe: sin scroll horizontal y «Campana» no vuelve.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByText('Campana')).toHaveCount(0);
});
