import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { comoAdmin } from './como-admin';

/**
 * Capturas de la previa de «Escribirle a varios» (#1247), en día y noche.
 *
 * Solo con `CAPTURAS=1`. La previa se intercepta: lo que se fotografía es
 * cómo se DICE quién queda fuera —con el plural según su número—, no qué
 * contactos hay en la base del e2e. Nunca se aprieta «Enviar».
 */
const auth = JSON.parse(readFileSync(join(__dirname, '.auth.json'), 'utf8'));
const DESTINO = join(__dirname, '..', '..', '..', 'docs', 'evidencias', '1247');

test.skip(!process.env.CAPTURAS, 'solo con CAPTURAS=1');

const PREVIA = {
  id: 'd1',
  texto: 'Gracias por escribirnos esta semana. Seguimos con la promoción hasta el viernes.',
  total: 3,
  muestra: [
    { conversationId: 'c1', nombre: 'Camila Fuentes', telefono: '+56911···01' },
    { conversationId: 'c2', nombre: 'Matías Rojas', telefono: '+56911···02' },
    { conversationId: 'c3', nombre: 'Josefa Contreras', telefono: '+56911···03' },
  ],
  fuera: [
    { motivo: 'se dio de baja', n: 1 },
    { motivo: 'ventana cerrada', n: 2 },
    { motivo: 'es del equipo', n: 2 },
  ],
  truncado: false,
  enSilencio: false,
};

for (const modo of ['dia', 'noche'] as const) {
  test(`previa de escribirle a varios · ${modo}`, async ({ page }) => {
    mkdirSync(DESTINO, { recursive: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(
      ([a, m]) => {
        localStorage.setItem('pulso-mode', m);
        localStorage.setItem('sb-127-auth-token', JSON.stringify({
          access_token: a.accessToken, token_type: 'bearer', expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'e2e',
          user: { id: a.userId, aud: 'authenticated', email: 'supervisora@e2e.cl' },
        }));
      },
      [auth, modo] as const,
    );
    await comoAdmin(page, auth);
    await page.route('**/v1/conversations/difusion/previa', (r) => r.fulfill({ json: PREVIA }));
    await page.goto('/bandeja');
    await page.getByRole('button', { name: 'Escribirle a varios' }).first().click();
    const dialogo = page.getByRole('dialog');
    await dialogo.getByLabel('El mensaje').fill(PREVIA.texto);
    await dialogo.getByRole('button', { name: 'Ver a quién le llega' }).click();
    await expect(dialogo.getByRole('button', { name: 'Enviar a 3' })).toBeVisible();
    await expect(dialogo.getByText('que pidió no recibir mensajes')).toBeVisible();
    await expect(dialogo.getByText('que son del equipo')).toBeVisible();
    await page.screenshot({ path: join(DESTINO, `previa-${modo}-1440.png`) });
  });
}
