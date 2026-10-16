import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const auth = JSON.parse(readFileSync(join(__dirname, '.auth.json'), 'utf8')) as {
  apiUrl: string; registrations: Array<{ mode: 'dia' | 'noche'; userId: string; accessToken: string }>;
};

for (const identity of auth.registrations) {
  test(`registro real y reanudación a 360px · ${identity.mode}`, async ({ page, request }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width: 360, height: 800 });
    await page.addInitScript(({ token, userId, mode }) => {
      localStorage.setItem('sb-127-auth-token', JSON.stringify({
        access_token: token, token_type: 'bearer', expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'e2e',
        user: { id: userId, aud: 'authenticated', email: 'alta@e2e.cl' },
      }));
      localStorage.setItem('pulso-mode', mode);
    }, { token: identity.accessToken, userId: identity.userId, mode: identity.mode });
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Crear mi negocio' })).toBeVisible();
    // El modo es del sistema compartido; se fija explícitamente para documentar ambas variantes.
    await page.evaluate((mode) => { document.documentElement.dataset.mode = mode; }, identity.mode);
    await page.getByLabel('Tu nombre', { exact: true }).fill('Ana');
    await page.getByLabel('Nombre del negocio', { exact: true }).fill(`Negocio ${identity.mode}`);
    await page.getByLabel('Descripción del negocio', { exact: true }).fill('Barbería con reservas de hora en Ñuñoa.');
    await page.getByRole('combobox', { name: 'Rubro' }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('option', { name: 'Belleza y estética' }).click();
    await page.getByRole('textbox', { name: 'Descripción del negocio', exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Crear mi negocio' })).toBeFocused();
    const outline = await page.getByRole('button', { name: 'Crear mi negocio' }).evaluate((element) => getComputedStyle(element).outlineWidth);
    expect(parseFloat(outline)).toBeGreaterThan(0);
    const directory = join(__dirname, '../../..', 'docs/evidencias/56');
    mkdirSync(directory, { recursive: true });
    await page.screenshot({ path: join(directory, `registro-${identity.mode}-360.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('region', { name: 'Puesta en marcha de tu negocio' })).toBeVisible();
    await expect(page.getByText('Tu prueba y tus costos')).toBeVisible();
    await expect(page.getByText(/Prueba gratis, sin tarjeta hasta/)).toBeVisible();
    await expect(page.getByText('Meta · consumo registrado del ciclo')).toBeVisible();
    await expect(page.getByText('IA · consumo registrado del ciclo')).toBeVisible();
    const linkContrast = await page.getByRole('link', { name: 'Ver facturación y consumo' }).evaluate((element) => {
      const luminance = (color: string) => {
        const [r, g, b] = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number).map((channel) => {
          const value = channel / 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
        return r! * 0.2126 + g! * 0.7152 + b! * 0.0722;
      };
      const ink = luminance(getComputedStyle(element).color);
      const background = luminance(getComputedStyle(element.closest('section')!).backgroundColor);
      return (Math.max(ink, background) + 0.05) / (Math.min(ink, background) + 0.05);
    });
    expect(linkContrast).toBeGreaterThanOrEqual(4.5);
    await page.getByRole('region', { name: 'Tu prueba y tus costos' }).screenshot({ path: join(directory, `costos-${identity.mode}-360.png`) });
    const me = await request.get(`${auth.apiUrl}/v1/me`, { headers: { Authorization: `Bearer ${identity.accessToken}` } });
    expect(me.ok()).toBe(true);
    const tenants = (await me.json()).tenants;
    expect(tenants).toHaveLength(1); expect(tenants[0].roleName).toBe('ADMIN');
    await page.reload();
    await expect(page.getByRole('region', { name: 'Puesta en marcha de tu negocio' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Crear mi negocio' })).toHaveCount(0);
    await page.goto('/ajustes/ia');
    await expect(page.getByRole('textbox', { name: 'Descripción del negocio' })).toHaveValue('Barbería con reservas de hora en Ñuñoa.');
    expect(errors).toEqual([]);
  });
}
