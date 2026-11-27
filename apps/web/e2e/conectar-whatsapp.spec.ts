import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Conectar WhatsApp desde la app (#1393), en la pantalla real.
 *
 * Zernio no está en las pruebas: las dos rutas que le hablan se interceptan
 * con lo que devolverían después de pasar por Meta. Lo que se prueba es el
 * camino de la pantalla —la tarjeta, el diálogo, el número para conectar— y
 * que el pedido de alta sale con su `Idempotency-Key`. Con `CAPTURAS=1`
 * deja día y noche, en escritorio y celular.
 *
 * Desde #1405 el flujo empieza con la elección de la dueña —cómo usa hoy ese
 * número— que viaja al enlace de Meta y sobrevive la vuelta para el alta: la
 * «Meta» de mentira está en el mismo origen para que el sessionStorage cruce.
 */
const auth = JSON.parse(readFileSync(join(__dirname, '.auth.json'), 'utf8'));
const DESTINO = join(__dirname, '..', '..', '..', 'docs', 'evidencias', '1393');

for (const [modo, ancho, alto] of [['dia', 1280, 900], ['noche', 1280, 900], ['dia', 390, 844], ['noche', 390, 844]] as const) {
  test(`conectar WhatsApp desde Canales · ${modo} · ${ancho}`, async ({ page }) => {
    await page.setViewportSize({ width: ancho, height: alto });
    await page.addInitScript(
      ([a, m]) => {
        // La supervisora es ADMIN aquí (#902): Canales pide channels.manage.
        localStorage.setItem('iaxti-tenant', a.campaignTenantId);
        localStorage.setItem('pulso-mode', m);
        localStorage.setItem('sb-127-auth-token', JSON.stringify({
          access_token: a.accessToken, token_type: 'bearer', expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'e2e',
          user: { id: a.userId, aud: 'authenticated', email: 'supervisora@e2e.cl' },
        }));
      },
      [auth, modo] as const,
    );
    // Sin canales de WhatsApp: el negocio recién empieza.
    await page.route('**/v1/channels', (r) => r.fulfill({ json: [] }));
    await page.route('**/v1/channels/whatsapp/numeros', (r) =>
      r.fulfill({ json: [{ cuenta: 'acc_demo', nombre: '+56 9 2201 3949', pideReconectar: false, yaConectado: false }] }),
    );
    // El enlace de Meta (#1405): la elección de la dueña viaja en el cuerpo.
    // La «Meta» de mentira vive en el mismo origen de la app para que el
    // sessionStorage —donde sobrevive la elección— cruce el pase y la vuelta.
    let enlace: { cuerpo: unknown } | null = null;
    await page.route('**/v1/channels/whatsapp/enlace', async (r) => {
      enlace = { cuerpo: r.request().postDataJSON() };
      await r.fulfill({ json: { url: new URL('/meta-de-mentira', page.url()).toString() } });
    });
    await page.route('**/meta-de-mentira', (r) =>
      r.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html lang="es"><title>Meta de mentira</title><p>Aquí autorizas tu número.</p></html>',
      }),
    );
    let alta: { cuerpo: unknown; llave: string | undefined } | null = null;
    await page.route('**/v1/channels/whatsapp/conectar', async (r) => {
      alta = { cuerpo: r.request().postDataJSON(), llave: r.request().headers()['idempotency-key'] };
      await r.fulfill({ json: { id: 'c1', name: 'WhatsApp', state: 'active', renovada: false } });
    });

    await page.goto('/ajustes/canales');
    const tarjeta = page.getByRole('listitem').filter({ hasText: 'WhatsApp' }).first();
    await expect(tarjeta.getByText('Sin conectar')).toBeVisible();
    if (process.env.CAPTURAS) {
      mkdirSync(DESTINO, { recursive: true });
      await page.screenshot({ path: join(DESTINO, `canales-${modo}-${ancho}.png`) });
    }

    await tarjeta.getByRole('button', { name: 'Conectar' }).click();
    const dialogo = page.getByRole('dialog');
    await expect(dialogo.getByText('¿Cómo usas hoy ese número?')).toBeVisible();
    // Antes de ir a Meta, la dueña dice cómo usa hoy ese número (#1405). Sin
    // elección el botón no se aprieta, así que acá se elige la coexistencia.
    await dialogo.getByRole('button', { name: 'Lo uso en la app WhatsApp Business del teléfono' }).click();
    await expect(dialogo.getByRole('button', { name: 'Conectar este número' })).toBeVisible();
    await expect(dialogo.getByRole('button', { name: 'Conectar otro número' })).toBeVisible();
    if (process.env.CAPTURAS) {
      // El diálogo entra con un fundido: capturarlo a mitad lo deja translúcido.
      await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
      await page.screenshot({ path: join(DESTINO, `conectar-${modo}-${ancho}.png`) });
    }

    await dialogo.getByRole('button', { name: 'Conectar otro número' }).click();
    await page.waitForURL('**/meta-de-mentira');
    expect(enlace!.cuerpo).toEqual({ modo: 'coexistencia' });

    // La vuelta de Meta (?whatsapp=volvio) reabre el diálogo, y el alta manda
    // el modo que quedó guardado: la cuenta sabe que convive con la app.
    await page.goto('/ajustes/canales?whatsapp=volvio');
    const dialogoDeVuelta = page.getByRole('dialog');
    await expect(dialogoDeVuelta.getByRole('button', { name: 'Conectar este número' })).toBeVisible();
    await dialogoDeVuelta.getByRole('button', { name: 'Conectar este número' }).click();
    await expect.poll(() => alta).not.toBeNull();
    expect(alta!.cuerpo).toEqual({ cuenta: 'acc_demo', modo: 'coexistencia' });
    expect(alta!.llave).toMatch(/^[0-9a-f-]{36}$/);
  });
}
