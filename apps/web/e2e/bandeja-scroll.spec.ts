import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const auth = JSON.parse(readFileSync(join(__dirname, '.auth.json'), 'utf8'));

async function documentoAjustado(page: Page) {
  // Se intenta desplazar el DOCUMENTO, no solo comprobar un contenedor.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(() => page.evaluate(() => ({
    y: window.scrollY,
    extraY: document.documentElement.scrollHeight - window.innerHeight,
    extraX: document.documentElement.scrollWidth - window.innerWidth,
  }))).toEqual({ y: 0, extraY: 0, extraX: 0 });
}

for (const viewport of [{ width: 1366, height: 768 }, { width: 768, height: 768 }, { width: 360, height: 640 }]) {
  test(`Bandeja mantiene el scroll en sus paneles a ${viewport.width} px (#429)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.addInitScript((auth) => {
      localStorage.setItem('iaxti-tenant', auth.tenantId);
      localStorage.setItem('sb-127-auth-token', JSON.stringify({
        access_token: auth.accessToken, token_type: 'bearer', expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'e2e',
        user: { id: auth.userId, aud: 'authenticated', email: 'scroll@e2e.cl' },
      }));
    }, auth);
    // Volumen determinista sin crear conversaciones o mensajes en la BD.
    // Auth, módulos, ficha y permisos usan la API local del runner.
    await page.route('**/v1/conversations', async (route) => {
      const response = await route.fetch({ url: `${route.request().url()}/${auth.conversationId}` });
      const base = await response.json();
      expect(base.id).toBe(auth.conversationId);
      await route.fulfill({ json: { items: Array.from({ length: 50 }, (_, i) => ({
        ...base, id: i === 0 ? base.id : `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        contactName: `Contacto de prueba ${String(i + 1).padStart(2, '0')}`,
      })) } });
    });
    await page.route('**/v1/conversations/*/messages', (route) => route.fulfill({ json:
      Array.from({ length: 80 }, (_, i) => ({
        id: `mensaje-scroll-${i}`, direction: 'in', type: 'text', deliveryStatus: null,
        authorKind: 'contact', createdAt: new Date(Date.now() - i * 60_000).toISOString(),
        body: `Mensaje de prueba ${i + 1}. Historial largo para comprobar el desplazamiento.`,
      })),
    }));
    let soporte = false;
    await page.route('**/v1/support-status', (route) => route.fulfill({ json: {
      active: soporte, until: soporte ? new Date(Date.now() + 3_600_000).toISOString() : null,
    } }));

    await page.goto('/bandeja');
    const lista = page.getByRole('region', { name: 'Conversaciones', exact: true });
    await expect(lista.getByRole('button', { name: /Contacto de prueba 50/ })).toBeAttached();
    await documentoAjustado(page);
    await lista.hover();
    await page.mouse.wheel(0, 900);
    await expect.poll(() => lista.evaluate((n) => n.scrollTop)).toBeGreaterThan(0);
    await expect(page.getByRole('heading', { name: 'Bandeja', exact: true })).toBeInViewport();
    await lista.evaluate((n) => { n.scrollTop = n.scrollHeight; });
    await expect(lista.getByRole('button', { name: /Contacto de prueba 50/ })).toBeInViewport();
    await page.mouse.wheel(0, 4000);
    await documentoAjustado(page);

    // El aviso ocupa altura real; no debe empujar la respuesta fuera de pantalla.
    soporte = true;
    await page.reload();
    await expect(page.getByRole('status').filter({ hasText: 'El soporte de IAxTi' })).toBeVisible();
    await expect(lista.getByRole('button', { name: /Contacto de prueba 01/ })).toBeVisible();
    await documentoAjustado(page);
    await lista.getByRole('button', { name: /Contacto de prueba 01/ }).click();
    const chat = page.getByRole('region', { name: 'Conversación', exact: true });
    const respuesta = page.getByLabel('Mensaje', { exact: true });
    await expect(respuesta).toBeInViewport();
    await documentoAjustado(page);
    const historial = chat.locator('ol').locator('..');
    await expect.poll(() => historial.evaluate((n) => n.scrollTop)).toBeGreaterThan(0);
    await historial.hover();
    await page.mouse.wheel(0, -await historial.evaluate((n) => n.scrollHeight));
    await expect.poll(() => historial.evaluate((n) => n.scrollTop)).toBe(0);
    await expect(chat.getByText('Mensaje de prueba 80.', { exact: false })).toBeInViewport();
    await expect(respuesta).toBeInViewport();
    await documentoAjustado(page);
    await respuesta.focus();
    await expect(respuesta).toBeFocused();

    if (viewport.width < 1024) {
      await chat.getByRole('button', { name: 'Ficha', exact: true }).click();
      const ficha = page.getByRole('region', { name: 'Ficha del contacto' });
      await ficha.evaluate((n) => { n.scrollTop = n.scrollHeight; });
      await expect.poll(() => ficha.evaluate((n) => n.scrollTop)).toBeGreaterThan(0);
      await documentoAjustado(page);
      await ficha.getByRole('button', { name: 'Volver al chat' }).click();
      await expect(respuesta).toBeInViewport();
    }
    await page.setViewportSize({ width: viewport.width, height: viewport.height - 140 });
    await documentoAjustado(page);
    await expect(respuesta).toBeInViewport();
    await page.setViewportSize(viewport);
    await page.getByRole('button', { name: 'Buscar o ir a…', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await documentoAjustado(page);

    // Salir de Bandeja no deja un bloqueo global de scroll en otras rutas.
    await page.goto('/reportes');
    await expect(page.getByRole('heading', { name: 'Cómo va el negocio' })).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  });
}
