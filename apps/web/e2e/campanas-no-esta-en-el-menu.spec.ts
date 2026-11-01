import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Campañas no está en el menú, y la pantalla sigue existiendo (#1167).
 *
 * Lo pidió el dueño: «déjalo pero oculto por ahora, porque no tiene mucho
 * sentido, hace ruido visual». Hasta que haya una plantilla aprobada por Meta
 * y contactos con opt-in, `/campanas` se abre vacía — y en un menú que como
 * ADMIN necesita 762 px y ve 656 (#1108), cada entrada que no se usa empuja
 * a las que sí.
 *
 * Las DOS mitades se miden. Sacar la entrada es fácil; lo que hay que
 * sostener es que no se haya apagado la función de paso: el módulo
 * `automations` también trae las automatizaciones, que sí se usan, y apagarlo
 * se las llevaría por delante.
 */
const auth = JSON.parse(readFileSync(join(__dirname, '.auth.json'), 'utf8'));

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.addInitScript((a) => {
    localStorage.setItem('iaxti-tenant', a.tableTenantId);
    localStorage.setItem('pulso-mode', 'dia');
    localStorage.setItem('sb-127-auth-token', JSON.stringify({
      access_token: a.accessToken, token_type: 'bearer', expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'e2e',
      user: { id: a.userId, aud: 'authenticated', email: 'admin@e2e.cl' },
    }));
  }, auth);
});

test('el menú no muestra Campañas', async ({ page }) => {
  await page.goto('/contactos', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('link', { name: 'Contactos' }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Campañas' })).toHaveCount(0);
});

test('y el módulo sigue encendido: automatizaciones abre', async ({ page }) => {
  // La otra mitad de `automations` vive en el mismo manifiesto. Si alguien
  // «ocultara» campañas apagando el módulo, esto se caería — que es
  // justamente lo que hay que impedir.
  //
  // Se comprueba por la PANTALLA y no por un link del menú: Automatizaciones
  // no es una entrada de la barra, es una pestaña dentro de los ajustes de
  // IA (`seccion: Inteligencia` en el manifiesto). Lo escribí mal primero y
  // la prueba se puso roja buscando un link que nunca existió.
  await page.goto('/ajustes/automatizaciones', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText(/consentimiento ni en horario de silencio/)).toBeVisible({ timeout: 15_000 });
});

test('pero /campanas sigue abriendo', async ({ page }) => {
  await page.goto('/campanas', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Campañas' })).toBeVisible({ timeout: 15_000 });
  // Lo que NO puede decir: que no tenés permiso o que el módulo está apagado.
  await expect(page.getByText(/MODULE_DISABLED|No tienes permiso/)).toHaveCount(0);
});
