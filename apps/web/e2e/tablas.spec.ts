import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const auth = JSON.parse(readFileSync(join(__dirname, '.auth.json'), 'utf8'));
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

test('contactos: ordena en el servidor, pagina sin repetir y filtra desde cualquier página', async ({ page }) => {
  const urls: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/v1/contacts?')) urls.push(r.url()); });
  await page.goto('/contactos');
  const table = page.getByRole('table', { name: 'Contactos', exact: true });
  await expect(table.getByRole('row')).toHaveCount(26);
  await table.getByRole('button', { name: 'Contacto', exact: true }).click();
  await expect(table.getByRole('row').nth(1)).toContainText('Persona 01');
  await expect.poll(() => urls.at(-1)).toContain('sort=name&order=asc');
  await page.getByRole('button', { name: 'Siguiente', exact: true }).click();
  await expect(table.getByRole('row')).toHaveCount(6);
  await expect(table.getByRole('row').nth(1)).toContainText('Persona 26');
  expect(urls.at(-1)).toContain('cursor=');
  await page.getByRole('searchbox', { name: 'Buscar contactos' }).fill('Persona 02');
  await expect(table.getByRole('row')).toHaveCount(2);
  await expect(table.getByRole('row').nth(1)).toContainText('Persona 02');
  expect(urls.at(-1)).not.toContain('cursor=');
});

test('la selección permite agregar una etiqueta por la API, sin borrar ni reemplazar', async ({ page, request }) => {
  await page.goto('/contactos');
  const table = page.getByRole('table', { name: 'Contactos', exact: true });
  await expect(table.getByRole('row')).toHaveCount(26);
  const id = (await table.getByRole('row').nth(1).getByRole('link').getAttribute('href'))!.split('/').at(-1)!;
  const methods: string[] = [];
  page.on('request', (r) => methods.push(r.method()));
  await page.getByRole('checkbox', { name: 'Seleccionar fila 1', exact: true }).check();
  await page.getByRole('combobox', { name: 'Agregar etiqueta' }).selectOption(auth.tableTagId);
  await page.getByRole('button', { name: 'Agregar etiqueta', exact: true }).click();
  await expect(page.locator('[data-sonner-toast]')).toContainText('Etiqueta agregada a');
  const tags = await request.get(`http://127.0.0.1:4010/v1/tags/contacto/${id}`, { headers: { Authorization: `Bearer ${auth.accessToken}`, 'X-Tenant-Id': auth.tableTenantId } });
  expect((await tags.json()).some((t: { id: string }) => t.id === auth.tableTagId)).toBe(true);
  expect(methods).not.toContain('DELETE');
});

test('oportunidades conserva el kanban y ordena/filtra la vista de lista por API', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/oportunidades');
  await expect(page.getByRole('tab', { name: 'Tablero' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Lista', exact: true }).click();
  const table = page.getByRole('table', { name: 'Oportunidades', exact: true });
  await expect(table.getByRole('row')).toHaveCount(26);
  const order = table.getByRole('button', { name: /Monto CLP/ });
  await order.click();
  await expect(table.getByRole('row').nth(1)).toContainText('Venta 30');
  await order.click();
  await expect(table.getByRole('row').nth(1)).toContainText('Venta 01');
  await page.getByRole('button', { name: 'Siguiente', exact: true }).click();
  await expect(table.getByRole('row')).toHaveCount(6);
  await page.getByLabel('Valor desde (CLP)').fill('29000');
  await expect(table.getByRole('row')).toHaveCount(3);
  await expect(table.getByRole('row').nth(1)).toContainText('Venta 29');
});

for (const modo of ['dia', 'noche']) {
  test(`tablas a 360 px en ${modo}: columnas móviles y foco visible`, async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 900 });
    await page.goto('/contactos');
    const table = page.getByRole('table', { name: 'Contactos', exact: true });
    await expect(table.getByRole('row')).toHaveCount(26);
    await page.evaluate((modo) => document.documentElement.setAttribute('data-mode', modo), modo);
    await expect(table.getByRole('columnheader')).toHaveCount(2);
    await page.keyboard.press('Tab');
    const header = table.getByRole('button', { name: 'Contacto', exact: true });
    await header.focus();
    expect(await header.evaluate((el) => getComputedStyle(el).outlineWidth)).toBe('2px');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const folder = join(__dirname, '../../../docs/evidencias/299');
    mkdirSync(folder, { recursive: true });
    await page.screenshot({ path: join(folder, `contactos-${modo}-360.png`), fullPage: true });
    await page.goto('/oportunidades');
    await page.getByRole('tab', { name: 'Lista', exact: true }).click();
    await expect(page.getByRole('table').getByRole('row')).toHaveCount(26);
    await page.evaluate((modo) => document.documentElement.setAttribute('data-mode', modo), modo);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: join(folder, `oportunidades-${modo}-360.png`), fullPage: true });
  });
}
