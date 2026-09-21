import { expect, test, type Page } from '@playwright/test';

async function accesoCompleto(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  const medida = await page.evaluate(() => {
    const footer = document.querySelector('.pulso-access-footer')!.getBoundingClientRect();
    const controls = [...document.querySelectorAll('.pulso-access input, .pulso-access button')]
      .map((e) => ({ rect: e.getBoundingClientRect(), principal: e.matches('input, .h-control') }));
    return {
      horizontal: document.documentElement.scrollWidth > innerWidth,
      vertical: document.documentElement.scrollHeight > innerHeight,
      desplazado: scrollY !== 0,
      pieVisible: footer.top >= 0 && footer.bottom <= innerHeight,
      controlesVisibles: controls.every(({ rect }) => rect.top >= 0 && rect.bottom <= innerHeight),
      alturaControles: controls.filter((c) => c.principal).every(({ rect }) => rect.height >= 46),
    };
  });
  expect(medida).toEqual({ horizontal: false, vertical: false, desplazado: false,
    pieVisible: true, controlesVisibles: true, alturaControles: true });
}

test('acceso en horizontal y con altura reducida: controles alcanzables sin recortes', async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await page.goto('/login');
  await accesoCompleto(page);

  // Simula el espacio CSS disponible con zoom/teclado. En esta altura debe
  // poder desplazarse: ocultar overflow para "hacerlo caber" rompería el acceso.
  await page.setViewportSize({ width: 360, height: 320 });
  const correo = page.getByRole('textbox', { name: 'Tu correo' });
  await correo.focus();
  await correo.fill('persona@example.invalid');
  await correo.press('Tab');
  const enviar = page.getByRole('button', { name: 'Enviarme el acceso' });
  await expect(enviar).toBeFocused();
  await expect(enviar).toBeInViewport({ ratio: 1 });
  await page.keyboard.press('Tab');
  const google = page.getByRole('button', { name: 'Entrar con Google' });
  await expect(google).toBeFocused();
  await expect(google).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const pie = page.locator('.pulso-access-footer');
  await pie.scrollIntoViewIfNeeded();
  await expect(pie).toBeInViewport({ ratio: 1 });
});

// Solo se simula el proveedor OTP. La composición y los controles son los
// del build real; bandeja/teclado/tablas/campañas recorren además la API real.
for (const [width, height] of [[360, 640], [360, 741], [360, 900], [390, 844], [768, 600], [768, 741], [1024, 600], [1280, 720], [1366, 768], [1440, 900], [1440, 961]]) {
  for (const modo of ['dia', 'noche']) {
    test(`acceso completo: OTP, teclado y modo a ${width}×${height} en ${modo}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.addInitScript((modo) => {
        if (!localStorage.getItem('pulso-mode')) localStorage.setItem('pulso-mode', modo);
      }, modo);
      const errores: string[] = [];
      page.on('pageerror', (e) => errores.push(e.message));
      let falloEnvio = true;
      await page.route('**/auth/v1/otp*', (r) => r.fulfill({
        status: falloEnvio ? 400 : 200,
        json: falloEnvio ? { msg: 'Error de envío de prueba' } : {},
      }));
      await page.route('**/auth/v1/verify', (r) => r.fulfill({ status: 403, json: { msg: 'Código de prueba vencido' } }));
      await page.goto('/login');
      await expect(page.getByRole('heading', { name: 'Entra a IAxTi' })).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-mode', modo);
      await accesoCompleto(page);
      const correo = page.getByRole('textbox', { name: 'Tu correo' });
      await correo.focus();
      await expect(correo).toBeFocused();
      await expect(correo).toHaveCSS('outline-width', '2px');
      const colorFoco = await page.evaluate(() => {
        const muestra = document.createElement('span');
        muestra.style.color = 'var(--focus)';
        document.body.append(muestra);
        const color = getComputedStyle(muestra).color;
        muestra.remove();
        return color;
      });
      await expect(correo).toHaveCSS('outline-color', colorFoco);
      await correo.fill('persona@example.invalid');
      await correo.press('Tab');
      await expect(page.getByRole('button', { name: 'Enviarme el acceso' })).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.getByText('No pudimos enviar el código.')).toBeVisible();
      await accesoCompleto(page);
      falloEnvio = false;
      await page.keyboard.press('Enter');
      const codigo = page.getByRole('textbox', { name: 'Código', exact: true });
      await expect(codigo).toBeFocused();
      await accesoCompleto(page);
      await codigo.fill('123456');
      await page.getByRole('button', { name: 'Entrar', exact: true }).click();
      await expect(page.getByText('Ese código no sirvió.')).toBeVisible();
      await accesoCompleto(page);
      await page.getByRole('button', { name: 'Pedir otro código' }).click();
      await expect(correo).toHaveValue('persona@example.invalid');
      await page.getByRole('button', { name: 'Cambiar entre modo día y modo noche' }).click();
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-mode', modo === 'dia' ? 'noche' : 'dia');
      expect(errores).toEqual([]);
    });
  }
}
