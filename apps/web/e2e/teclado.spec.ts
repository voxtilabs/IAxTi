import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const auth = JSON.parse(readFileSync(join(__dirname, '.auth.json'), 'utf8'));
test.beforeEach(async ({ page }) => {
  await page.addInitScript((auth) => {
    localStorage.setItem('iaxti-tenant', auth.keyTenantId);
    localStorage.setItem('sb-127-auth-token', JSON.stringify({
      access_token: auth.accessToken, token_type: 'bearer', expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'e2e',
      user: { id: auth.userId, aud: 'authenticated', email: 'teclado@e2e.cl' },
    }));
  }, auth);
});

test('Ctrl+K navega a una pantalla y busca contactos y conversaciones en la API', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Buscar o ir a…' })).toBeVisible();
  await page.keyboard.press('Control+k');
  const input = page.getByRole('combobox', { name: 'Buscar pantallas, contactos o conversaciones' });
  await expect(input).toBeFocused();
  await input.fill('Contactos');
  await page.getByRole('option', { name: 'Contactos', exact: true }).click();
  await expect(page).toHaveURL(/\/contactos$/);
  await expect(page.getByRole('button', { name: 'Buscar o ir a…' })).toBeVisible();
  await page.keyboard.press('Control+k');
  await input.fill('Ana Teclado');
  const contacto = page.getByRole('option', { name: /Ana Teclado.*73000000/ });
  await expect(contacto).toBeVisible();
  await contacto.click();
  await expect(page).toHaveURL(new RegExp(`/contactos/${auth.keyConversations[0].contactId}$`));
  await expect(page.getByRole('button', { name: 'Buscar o ir a…' })).toBeVisible();
  await page.keyboard.press('Control+k');
  await input.fill('Cotización');
  await page.getByRole('option', { name: /Abrir conversación/ }).first().click();
  await expect(page).toHaveURL(/\/bandeja\?conversationId=/);
  await expect(page.getByRole('region', { name: 'Conversación', exact: true }).getByText(/Cotización de/)).toBeVisible();
});

test('j/k recorren, escribir no dispara e y resolver por teclado pasa por la API', async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/bandeja');
  await expect(page.getByRole('button', { name: /Beto Teclado/ })).toBeVisible();
  await page.keyboard.press('j');
  const chat = page.getByRole('region', { name: 'Conversación', exact: true });
  await expect(chat.getByText('Cotización de Beto Teclado')).toBeVisible();
  await page.keyboard.press('j');
  await expect(chat.getByText('Cotización de Ana Teclado')).toBeVisible();
  await page.keyboard.press('k');
  await expect(chat.getByText('Cotización de Beto Teclado')).toBeVisible();
  const message = page.getByRole('textbox', { name: 'Mensaje', exact: true });
  await message.fill('jke?');
  await message.press('e');
  await expect(message).toHaveValue('jke?e');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await page.keyboard.press('e');
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Conversación resuelta' })).toBeVisible();
  const result = await request.get(`http://127.0.0.1:4010/v1/conversations/${auth.keyConversations[1].conversationId}`, { headers: { Authorization: `Bearer ${auth.accessToken}`, 'X-Tenant-Id': auth.keyTenantId } });
  expect((await result.json()).state).toBe('resolved');
});

test('cambiar de negocio descarta la conversación sobre la que actúan los atajos', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/bandeja');
  await expect(page.getByRole('button', { name: /Ana Teclado/ })).toBeVisible();
  await page.keyboard.press('j');
  await expect(page.getByRole('textbox', { name: 'Mensaje', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Mostrar u ocultar el menú' }).click();
  await page.getByRole('combobox', { name: 'Negocio', exact: true }).selectOption(auth.tableTenantId);
  await expect(page.getByRole('textbox', { name: 'Mensaje', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Ana Teclado/ })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Todavía no te escribe nadie' })).toBeVisible();
});

test('ayuda visible, foco Pulso y los avisos de error usan sonner', async ({ page }) => {
  await page.goto('/bandeja');
  await page.getByRole('button', { name: 'Ayuda de atajos (?)' }).click();
  await expect(page.getByRole('dialog')).toContainText('Resolver la conversación abierta');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Ayuda de atajos (?)' })).toBeFocused();
  await page.route('**/v1/contacts?*', (r) => r.fulfill({ status: 503, json: { code: 'UNAVAILABLE', message: 'No pudimos cargar los contactos. Intenta nuevamente.' } }));
  await page.goto('/contactos');
  await expect(page.locator('[data-sonner-toast]')).toContainText('No pudimos cargar los contactos');
  await expect(page.locator('main p[role="alert"]')).toHaveCount(0);
});

for (const modo of ['dia', 'noche']) {
  test(`paleta a 360 px en ${modo}, con la sombra del sistema y movimiento reducido`, async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript((modo) => localStorage.setItem('pulso-mode', modo), modo);
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Buscar o ir a…' })).toBeVisible();
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog');
    const input = page.getByRole('combobox', { name: 'Buscar pantallas, contactos o conversaciones' });
    await expect(input).toBeFocused();
    await page.evaluate((modo) => document.documentElement.setAttribute('data-mode', modo), modo);
    expect(await input.evaluate((el) => getComputedStyle(el).outlineWidth)).toBe('2px');
    expect(await input.evaluate((el) => el.getBoundingClientRect().left - el.closest('[cmdk-root]')!.getBoundingClientRect().left)).toBeGreaterThanOrEqual(4);
    expect(await dialog.evaluate((el) => parseFloat(getComputedStyle(el).animationDuration))).toBeLessThanOrEqual(0.001);
    // Antes exigía `none`, y era correcto: Pulso prohibía toda sombra. La
    // ADR-0018 agregó UNA, y la paleta es justo uno de los seis que flotan.
    // La comprobación no se afloja, cambia de objeto: ya no "ninguna" sino
    // "exactamente la del sistema y ninguna otra". Se resuelve el token en
    // el mismo motor para no comparar texto contra texto.
    const sombraDelSistema = await page.evaluate(() => {
      const valor = getComputedStyle(document.documentElement)
        .getPropertyValue('--elevacion-flotante')
        .trim();
      const sonda = document.createElement('div');
      sonda.style.boxShadow = valor;
      document.body.appendChild(sonda);
      const resuelta = getComputedStyle(sonda).boxShadow;
      sonda.remove();
      return resuelta;
    });
    expect(sombraDelSistema).not.toBe('none');
    // Tailwind compone `box-shadow` con tres capas —anillo de offset,
    // anillo y sombra— y las dos primeras van transparentes cuando no hay
    // anillo. Comparar la cadena entera contra el token falla por la forma,
    // no por el color. Lo que se quiere afirmar es: una sola capa visible, y
    // que sea la del sistema.
    const capas = (await dialog.evaluate((el) => getComputedStyle(el).boxShadow))
      .split(/,(?![^(]*\))/)
      .map((c) => c.trim());
    const visibles = capas.filter((c) => !c.startsWith('rgba(0, 0, 0, 0)'));
    expect(visibles).toEqual([sombraDelSistema]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const folder = join(__dirname, '../../../docs/evidencias/300');
    mkdirSync(folder, { recursive: true });
    await page.screenshot({ path: join(folder, `paleta-${modo}-360.png`) });
  });
}

test('sin preferencia reducida, el diálogo entra en 150 ms', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Buscar o ir a…' })).toBeVisible();
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await page.getByRole('dialog').evaluate((el) => getComputedStyle(el).animationDuration)).toBe('0.15s');
});
