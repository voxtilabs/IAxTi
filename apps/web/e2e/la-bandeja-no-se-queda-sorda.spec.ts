import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Con el canal de tiempo real caído, la bandeja SIGUE trabajando y lo dice (#1116).
 *
 * `canal.subscribe()` iba sin callback de estado, así que nadie miraba nunca
 * si el canal quedó conectado. Cuando no queda, la lista se congela y se ve
 * EXACTAMENTE IGUAL que una bandeja sin mensajes nuevos: quien atiende no
 * puede distinguir «no escribió nadie» de «dejamos de escuchar», y va a creer
 * lo primero, que es lo tranquilizador.
 *
 * Es de comportamiento y no de fuente porque la pregunta es «¿qué pasa cuando
 * se cae?», y eso solo se contesta tirándolo abajo (#564).
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
});

test('sin canal: lo dice y sigue trayendo la lista sola', async ({ page }) => {
  // El stub de Supabase del e2e no implementa realtime, así que el canal NUNCA
  // conecta: es el escenario exacto, sin tener que falsearlo.
  let listas = 0;
  await page.route('**/v1/conversations?**', (r) => { listas += 1; return r.fallback(); });
  await page.route('**/v1/conversations', (r) => { listas += 1; return r.fallback(); });

  await page.goto('/bandeja');
  await expect(page.getByRole('heading', { name: 'Bandeja', exact: true })).toBeVisible();

  // Pasada la gracia lo dice. Antes de la gracia NO, que es lo que evita que
  // parpadee en cada carga.
  await expect(page.getByRole('status').filter({ hasText: 'Sin conexión en vivo' })).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'Sin conexión en vivo' }))
    .toBeVisible({ timeout: 15_000 });

  // Y el respaldo trabaja: la lista se vuelve a pedir sin que nadie toque nada.
  const antes = listas;
  await expect.poll(() => listas, { timeout: 30_000 }).toBeGreaterThan(antes);
});

test('el aviso no parpadea al cargar: antes de la gracia, nada', async ({ page }) => {
  // Honesto sobre lo que mide: esto NO prueba que con el canal sano no se
  // sondee —el stub del e2e no habla realtime, así que no hay forma de
  // conectarlo desde acá; esa mitad la sostiene el `if (enVivo) return;` del
  // efecto, y se ve en staging, que sí tiene un Supabase de verdad.
  //
  // Lo que sí prueba, y vale: que el aviso no aparezca en cada carga. `enVivo`
  // arranca en false porque todavía no conectó, y sin la gracia la bandeja se
  // abriría con un aviso amarillo que se va solo a los dos segundos. Un aviso
  // que aparece y desaparece enseña a ignorarlo, que es lo contrario de lo que
  // este aviso tiene que conseguir.
  await page.goto('/bandeja');
  await expect(page.getByRole('heading', { name: 'Bandeja', exact: true })).toBeVisible();
  const cartel = page.getByRole('status').filter({ hasText: 'Sin conexión en vivo' });
  await expect(cartel).toHaveCount(0);
  // Y un rato después sigue sin estar, porque la gracia no venció todavía.
  await page.waitForTimeout(2_000);
  await expect(cartel).toHaveCount(0);
});
