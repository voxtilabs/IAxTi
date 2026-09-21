import { expect, test } from '@playwright/test';

// Solo se simula el proveedor OTP. La composición y los controles son los
// del build real; bandeja/teclado/tablas/campañas recorren además la API real.
for (const width of [360, 1440]) {
  for (const modo of ['dia', 'noche']) {
    test(`acceso Pulso Vivo: OTP, teclado y modo a ${width}px en ${modo}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.addInitScript((modo) => {
        if (!localStorage.getItem('pulso-mode')) localStorage.setItem('pulso-mode', modo);
      }, modo);
      const errores: string[] = [];
      page.on('pageerror', (e) => errores.push(e.message));
      await page.route('**/auth/v1/otp*', (r) => r.fulfill({ json: {} }));
      await page.route('**/auth/v1/verify', (r) => r.fulfill({ status: 403, json: { msg: 'Código de prueba vencido' } }));
      await page.goto('/login');
      await expect(page.getByRole('heading', { name: 'Entra a IAxTi' })).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-mode', modo);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const correo = page.getByRole('textbox', { name: 'Tu correo' });
      await correo.focus();
      expect(await correo.evaluate((e) => getComputedStyle(e).outlineWidth)).toBe('2px');
      await correo.fill('persona@example.invalid');
      await correo.press('Tab');
      await expect(page.getByRole('button', { name: 'Enviarme el acceso' })).toBeFocused();
      await page.keyboard.press('Enter');
      const codigo = page.getByRole('textbox', { name: 'Código', exact: true });
      await expect(codigo).toBeFocused();
      await codigo.fill('123456');
      await page.getByRole('button', { name: 'Entrar', exact: true }).click();
      await expect(page.getByText('Ese código no sirvió.')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.getByRole('button', { name: 'Pedir otro código' }).click();
      await expect(correo).toHaveValue('persona@example.invalid');
      await page.getByRole('button', { name: 'Cambiar entre modo día y modo noche' }).click();
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-mode', modo === 'dia' ? 'noche' : 'dia');
      expect(errores).toEqual([]);
    });
  }
}
