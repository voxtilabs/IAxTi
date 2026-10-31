import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { comoAdmin } from './como-admin';

/**
 * Los avisos push se OFRECEN (#1114).
 *
 * Las tres llamadas de lectura de esta pantalla iban con `fetch` a mano y sin
 * `X-Tenant-Id`. La API contestaba `401 TENANT_REQUIRED` con un JSON válido,
 * así que `.json()` no fallaba; `publicKey` quedaba `undefined`, el componente
 * lo leía como «no disponible» y devolvía `null`. La sección no se dibujaba
 * nunca — sin error en pantalla y sin nada en los registros.
 *
 * Por eso la primera aserción es sobre la PETICIÓN y no sobre lo que se ve: el
 * síntoma era una ausencia, y mirar la pantalla no distingue «no corresponde
 * mostrarlo» de «se rompió en silencio».
 */
const auth = JSON.parse(readFileSync(join(__dirname, '.auth.json'), 'utf8'));

test.beforeEach(async ({ page }) => {
  await page.addInitScript((a) => {
    localStorage.setItem('iaxti-tenant', a.tenantId);
    localStorage.setItem('pulso-mode', 'dia');
    localStorage.setItem('sb-127-auth-token', JSON.stringify({
      access_token: a.accessToken, token_type: 'bearer', expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'e2e',
      user: { id: a.userId, aud: 'authenticated', email: 'supervisora@e2e.cl' },
    }));
  }, auth);
  await comoAdmin(page, auth);
});

test('la pantalla pregunta por la llave CON el negocio, y no recibe 401', async ({ page }) => {
  const pedidos: { tenant: string | undefined; estado: number }[] = [];
  page.on('response', async (r) => {
    if (!r.url().includes('/notifications/push/clave')) return;
    pedidos.push({ tenant: r.request().headers()['x-tenant-id'], estado: r.status() });
  });

  await page.goto('/ajustes/notificaciones');
  await expect(page.getByRole('heading', { name: /avisos/i }).first()).toBeVisible();
  await expect.poll(() => pedidos.length).toBeGreaterThan(0);

  for (const p of pedidos) {
    expect(p.tenant, 'la llamada salió sin X-Tenant-Id: la API la rechaza con 401').toBe(auth.tableTenantId);
    expect(p.estado, 'la llamada por la llave de push fue rechazada').toBe(200);
  }
});

test('si no se puede preguntar, lo dice; no borra la sección en silencio', async ({ page }) => {
  // El servidor contesta lo que contestaba antes del arreglo, con su JSON
  // válido: lo que no puede volver a pasar es que eso se dibuje como nada.
  await page.route('**/v1/notifications/push/clave', (r) =>
    r.fulfill({ status: 401, contentType: 'application/json',
      body: JSON.stringify({ code: 'TENANT_REQUIRED', message: 'Indica el negocio.', requestId: 'req_x', details: [] }) }));

  await page.goto('/ajustes/notificaciones');
  await expect(page.getByText('No pudimos preguntarle al servidor')).toBeVisible();
});
