import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Criterio de salida de la Fase 2 (SPEC §31, #37): un supervisor asigna una
// conversación simulada y la resuelve DESDE EL CELULAR. La sesión se inyecta
// como la guardaría supabase-js (localStorage); el token lo firmó run-e2e.mjs
// y la API lo verifica contra el JWKS local — el mismo camino que producción.

interface Auth {
  accessToken: string;
  userId: string;
  tenantId: string;
  conversationId: string;
}

const auth: Auth = JSON.parse(readFileSync(join(__dirname, '.auth.json'), 'utf8'));

test.beforeEach(async ({ page }) => {
  const sesion = {
    access_token: auth.accessToken,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: 'e2e',
    user: { id: auth.userId, aud: 'authenticated', email: 'supervisora@e2e.cl' },
  };
  await page.addInitScript(
    ([clave, valor, tenant]) => {
      localStorage.setItem(clave, valor);
      localStorage.setItem('iaxti-tenant', tenant);
    },
    ['sb-127-auth-token', JSON.stringify(sesion), auth.tenantId] as const,
  );
});

test('la supervisora asigna la conversación simulada y la resuelve desde el celular', async ({ page }) => {
  await page.goto('/bandeja');

  // Panel lista (pantalla 1 de 3 en celular): la conversación simulada está.
  const item = page.getByRole('button', { name: /\+56 ?9/ }).first();
  await expect(item).toBeVisible();
  await item.click();

  // Pantalla de chat: el mensaje del cliente se lee completo.
  await expect(page.getByText('¿me pueden ayudar con una cotización?')).toBeVisible();

  // Asignársela (permiso conversations.assign del SUPERVISOR).
  const chat = page.getByRole('region', { name: 'Conversación' });
  await page.getByTestId('acciones').click();
  await page.getByRole('menuitem', { name: 'Asignármela' }).click();
  await expect(chat.getByText('En curso')).toBeVisible();

  // Responde: el mensaje aparece en la conversación y el simulador entrega.
  await page.getByLabel('Mensaje').fill('¡Hola! Te preparo la cotización altiro.');
  await page.getByLabel('Enviar').click();
  await expect(page.getByText('Te preparo la cotización altiro')).toBeVisible();

  // La resuelve.
  await page.getByTestId('acciones').click();
  await page.getByTestId('resolver').click();
  await expect(chat.getByText('Resuelta')).toBeVisible();

  // La ficha (pantalla 3) también navega en celular.
  await page.getByRole('button', { name: 'Ficha' }).click();
  await expect(page.getByText('Consentimiento')).toBeVisible();
  await page.getByRole('button', { name: 'Volver al chat' }).click();
  await expect(page.getByLabel('Mensaje')).toBeVisible();
});
