import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const auth = JSON.parse(readFileSync(join(__dirname, '.auth.json'), 'utf8'));
const baseline = process.env.IAXTI_CAPTURA_ANTES === '1';
const destino = join(__dirname, '../../../docs/evidencias/297', baseline ? 'antes' : 'despues');

// Datos sintéticos de presentación; bandeja.spec.ts recorre además la API real.
for (const modo of ['dia', 'noche']) {
  for (const width of [360, 1280]) {
    test(`densidad y jerarquía a ${width}px en ${modo}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(({ auth, modo }) => {
        localStorage.setItem('iaxti-tenant', auth.tenantId);
        localStorage.setItem('pulso-mode', modo);
        localStorage.setItem('sb-127-auth-token', JSON.stringify({
          access_token: auth.accessToken, token_type: 'bearer', expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'e2e',
          user: { id: auth.userId, aud: 'authenticated', email: 'supervisora@e2e.cl' },
        }));
      }, { auth, modo });
      await page.route('**/v1/conversations', async (route) => {
        await route.fulfill({ json: { items: Array.from({ length: 20 }, (_, i) => ({
          id: `conversacion-${i}`, contactId: `contacto-${i}`, contactName: `Contacto de prueba ${i + 1}`,
          contactPhone: `+5698000${String(i).padStart(4, '0')}`, channel: 'simulador',
          state: 'new', ownerId: null, lastInboundAt: new Date().toISOString(),
          lastMessageAt: new Date().toISOString(), unansweredSeconds: 180, snoozedUntil: null,
        })), nextCursor: null } });
      });
      await page.goto('/bandeja');
      const filas = page.getByRole('button', { name: /Contacto de prueba/ });
      await expect(filas).toHaveCount(20);
      await page.evaluate((modo) => document.documentElement.setAttribute('data-mode', modo), modo);
      await page.evaluate(() => document.fonts.ready);
      const medidas = await filas.evaluateAll((rows) => {
        const contenedor = rows[0].closest('section')!.getBoundingClientRect();
        return {
          altoFila: rows[0].getBoundingClientRect().height,
          filasEnPanel: rows.filter((r) => r.getBoundingClientRect().bottom <= contenedor.bottom).length,
          visiblesEnPantalla: rows.filter((r) => r.getBoundingClientRect().bottom <= Math.min(contenedor.bottom, window.innerHeight)).length,
          overflow: document.documentElement.scrollWidth > window.innerWidth,
        };
      });
      if (!baseline) {
        expect(medidas.overflow).toBe(false);
        expect(medidas.altoFila).toBeLessThanOrEqual(60);
        await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
        const titulo = await page.getByRole('heading', { level: 1 }).evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
        expect(titulo).toBeGreaterThanOrEqual(24);
        if (width === 1280) expect(medidas.visiblesEnPantalla).toBeGreaterThanOrEqual(8);
        await filas.first().focus();
        expect(await filas.first().evaluate((el) => getComputedStyle(el).outlineWidth)).toBe('2px');
      }
      mkdirSync(destino, { recursive: true });
      writeFileSync(join(destino, `${modo}-${width}.json`), JSON.stringify(medidas, null, 2) + '\n');
      await page.screenshot({ path: join(destino, `${modo}-${width}.png`) });
    });
  }
}
