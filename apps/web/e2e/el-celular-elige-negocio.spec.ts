import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * En el celular el negocio también queda elegido (#1398).
 *
 * El negocio lo elegía el selector de la barra lateral, y en el celular la
 * barra no se monta hasta abrir el menú: quien entraba directo a «Tu
 * asistente» —sin pasar por el inicio— apretaba «Pedir» y no pasaba nada,
 * sin un error a la vista. Esta prueba entra así: celular, sin negocio
 * guardado, directo a la pantalla, y exige que el pedido salga.
 */
const auth = JSON.parse(readFileSync(join(__dirname, '.auth.json'), 'utf8'));

test('en el celular, «Pedir» envía aunque nunca se abrió el menú', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript((a) => {
    // A propósito SIN 'iaxti-tenant': es el caso de quien entra por primera
    // vez en este navegador, o con el almacenamiento limpio.
    localStorage.removeItem('iaxti-tenant');
    localStorage.setItem('sb-127-auth-token', JSON.stringify({
      access_token: a.accessToken, token_type: 'bearer', expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'e2e',
      user: { id: a.userId, aud: 'authenticated', email: 'supervisora@e2e.cl' },
    }));
  }, auth);
  // La IA del entorno de prueba no tiene proveedor: se responde por ella,
  // porque lo que se prueba es que el pedido SALGA, no lo que contesta.
  await page.route('**/v1/agents/diagnostico', (r) => r.fulfill({ json: { pasos: [], roto: null } }));
  let negocioDelPedido: string | undefined;
  await page.route('**/v1/agente-general', async (r) => {
    negocioDelPedido = r.request().headers()['x-tenant-id'];
    await r.fulfill({ json: { status: 'ok', texto: 'Listo, te escucho.', pasos: [], propuesta: null, vista: null, truncada: false } });
  });

  await page.goto('/ajustes/ia');
  const panel = page.getByRole('region', { name: 'Conversación con IAxTi' });
  await panel.getByLabel('Pídele algo a IAxTi').fill('Hola');
  await panel.getByRole('button', { name: 'Pedir', exact: true }).click();

  await expect(panel.getByText('Listo, te escucho.')).toBeVisible();
  expect(negocioDelPedido).toMatch(/^[0-9a-f-]{36}$/);
});
