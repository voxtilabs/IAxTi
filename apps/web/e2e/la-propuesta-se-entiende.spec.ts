import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * La propuesta del asistente se entiende (#1388), en la pantalla real.
 *
 * La respuesta del Agente General se intercepta con la propuesta que armó de
 * verdad el 25-11 para una peluquería (OpenAI, por el puerto del producto):
 * lo que se prueba es cómo la dibuja la app. Con `CAPTURAS=1` deja día y noche.
 */
const auth = JSON.parse(readFileSync(join(__dirname, '.auth.json'), 'utf8'));
const DESTINO = join(__dirname, '..', '..', '..', 'docs', 'evidencias', '1388');

const RESPUESTA = {
  status: 'ok',
  texto: 'Te dejé listo el asistente de precios. Revisa y dale el visto bueno.',
  pasos: [{ herramienta: 'agents.create', modulo: 'agents', metodo: 'POST', ruta: '/v1/agents', ok: true }],
  propuesta: {
    herramienta: 'agents.create',
    descripcion: 'Crea un asistente (proveedor y modelo configurables)',
    metodo: 'POST',
    ruta: '/v1/agents',
    permiso: 'agents.configure',
    argumentos: {
      name: 'Precios Peluquería Ñuñoa',
      personality: 'Habla de tú, cálido y breve. Responde solo precios y qué incluye, sin prometer horas ni descuentos.',
      language: 'es-CL',
      provider: 'openai',
      model: 'gpt-4o-mini',
      defaultMode: 'assist',
      objetivo: 'informar',
      objetivoDetalle: 'Responder precios: corte mujer $15.000, corte hombre $10.000, color desde $35.000',
    },
  },
  vista: null,
  truncada: false,
};

for (const modo of ['dia', 'noche'] as const) {
  test(`la propuesta dice lo que se decide · ${modo}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.addInitScript(
      ([a, m]) => {
        localStorage.setItem('iaxti-tenant', a.tenantId);
        localStorage.setItem('pulso-mode', m);
        localStorage.setItem('sb-127-auth-token', JSON.stringify({
          access_token: a.accessToken, token_type: 'bearer', expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'e2e',
          user: { id: a.userId, aud: 'authenticated', email: 'supervisora@e2e.cl' },
        }));
      },
      [auth, modo] as const,
    );
    await page.route('**/v1/agents/diagnostico', (r) => r.fulfill({ json: { pasos: [], roto: null } }));
    await page.route('**/v1/agente-general', (r) => r.fulfill({ json: RESPUESTA }));
    await page.goto('/ajustes/ia');
    const panel = page.getByRole('region', { name: 'Conversación con IAxTi' });
    await panel.getByLabel('Pídele algo a IAxTi').fill('Crea un asistente de precios para mi peluquería');
    await panel.getByRole('button', { name: 'Pedir', exact: true }).click();

    await expect(panel.getByText('Necesito tu visto bueno')).toBeVisible();
    await expect(panel.getByText('Te propone y tú confirmas')).toBeVisible();
    // Lo técnico no está a la vista hasta abrir el detalle.
    await expect(panel.getByText('gpt-4o-mini')).toBeHidden();

    if (process.env.CAPTURAS) {
      mkdirSync(DESTINO, { recursive: true });
      await panel.getByText('Necesito tu visto bueno').scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(DESTINO, `propuesta-${modo}.png`) });
      await panel.getByText('Ver detalle técnico').click();
      await expect(panel.getByText('gpt-4o-mini')).toBeVisible();
      await page.screenshot({ path: join(DESTINO, `propuesta-detalle-${modo}.png`) });
    }
  });
}
