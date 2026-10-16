import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const auth = JSON.parse(readFileSync(join(__dirname, '.auth.json'), 'utf8')) as { accessToken: string; userId: string; tenantId: string };
const dest = join(__dirname, '../../../docs/evidencias/57');
const state = 's'.repeat(43); const nonce = 'n'.repeat(43);
const disconnected = { configured: true, status: 'disconnected', calendarId: null, pushActive: false, lastNotificationAt: null };
for (const mode of ['dia', 'noche']) {
  test(`PKCE, callback y revocación con teclado a360 ${mode}`, async ({ page }) => {
    mkdirSync(dest, { recursive: true });
    const session = { access_token: auth.accessToken, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now()/1000)+3600,
      refresh_token: 'e2e', user: { id: auth.userId, aud: 'authenticated', email: 'user@example.test' } };
    await page.addInitScript(({ session, tenant, mode }) => { localStorage.setItem('sb-127-auth-token', JSON.stringify(session)); localStorage.setItem('iaxti-tenant', tenant); localStorage.setItem('pulso-mode', mode); }, { session, tenant: auth.tenantId, mode });
    let current = disconnected; let challenge = ''; let finish = 0; let revoke = 0; let failLoad = false; let reminderRequests = 0;
    page.on('request', request => { if (request.url().includes('/agenda/recordatorios')) reminderRequests++; });
    await page.route('**/v1/agenda/google', route => route.fulfill(failLoad ? { status: 503, json: { code: 'GOOGLE_UNAVAILABLE', message: 'No pudimos consultar Google. Intenta otra vez.', requestId: 'req-e2e-57' } } : { json: current }));
    await page.route('**/v1/agenda/google/iniciar', route => {
      const body = route.request().postDataJSON(); expect(Object.keys(body)).toEqual(['challenge']); challenge = body.challenge;
      return route.fulfill({ json: { state, nonce, url: `https://accounts.google.com/o/oauth2/v2/auth?state=${state}` } });
    });
    await page.route('https://accounts.google.com/**', route => route.fulfill({ status: 302, headers: { location: `http://127.0.0.1:4028/agenda/google/callback?code=test-code&state=${state}` } }));
    await page.route('**/v1/agenda/google/completar', route => {
      finish++; const body = route.request().postDataJSON(); expect(body).toMatchObject({ code: 'test-code', state, nonce });
      expect(createHash('sha256').update(body.verifier).digest('base64url')).toBe(challenge);
      current = { ...disconnected, status: 'active' };
      return route.fulfill({ json: current });
    });
    await page.route('**/v1/agenda/google/revocar', route => { revoke++; current = disconnected; return route.fulfill({ json: { revoked: true } }); });
    await page.goto('/agenda');
    const panel = page.getByRole('region', { name: 'Google Calendar', exact: true });
    const connect = panel.getByRole('button', { name: 'Conectar Google Calendar' }); await expect(connect).toBeVisible();
    // Llegar con teclado desde el documento, sin focus() al objetivo.
    for (let i=0; i<50 && !(await connect.evaluate(el=>el===document.activeElement)); i++) await page.keyboard.press('Tab');
    await expect(connect).toBeFocused();
    await expect(connect).toHaveCSS('outline-style', 'solid');
    await expect(page.getByRole('button', { name: 'Dar una hora' })).toHaveCount(0);
    await panel.screenshot({ path: join(dest, `google-${mode}-360-desconectado.png`) });
    await page.keyboard.press('Enter');
    await expect(page.getByRole('region', { name: 'Conexión de Google Calendar' }).getByText(/El permiso quedó guardado/)).toBeVisible(); expect(finish).toBe(1);
    await expect(page).toHaveURL('http://127.0.0.1:4028/agenda/google/callback');
    await expect(page.locator('meta[name=referrer]')).toHaveAttribute('content', 'no-referrer');
    expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key=>key.startsWith('iaxti-google-oauth:')).length)).toBe(0);
    const callbackLink = page.getByRole('link', { name: 'Volver a Agenda' });
    expect(await callbackLink.evaluate(element => {
      const luminance = (color: string) => {
        const [r, g, b] = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number).map(channel => {
          const c = channel / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return r! * 0.2126 + g! * 0.7152 + b! * 0.0722;
      };
      const ink = luminance(getComputedStyle(element).color);
      const bg = luminance(getComputedStyle(element.closest('section')!).backgroundColor);
      return (Math.max(ink, bg) + 0.05) / (Math.min(ink, bg) + 0.05);
    })).toBeGreaterThanOrEqual(4.5);
    await page.getByRole('region', { name: 'Conexión de Google Calendar' }).screenshot({ path: join(dest, `google-${mode}-360-callback.png`) });
    await callbackLink.click();
    await expect(panel.getByText(/notificaciones de cambios están pendientes/)).toBeVisible();
    await panel.getByRole('button', { name: 'Revocar permisos' }).click();
    const dialog = page.getByRole('dialog'); await expect(dialog.getByText(/también los usados en otros negocios/)).toBeVisible();
    await page.keyboard.press('Tab');
    const confirm = dialog.getByRole('button', { name: 'Revocar permisos de Google' });
    for (let i=0; i<6 && !(await confirm.evaluate(el=>el===document.activeElement)); i++) await page.keyboard.press('Tab');
    await expect(confirm).toBeFocused();
    expect(await confirm.evaluate(el => {
      const range = document.createRange(); range.selectNodeContents(el);
      const text = range.getBoundingClientRect(); const button = el.getBoundingClientRect();
      return text.top >= button.top && text.bottom <= button.bottom && text.left >= button.left && text.right <= button.right;
    })).toBe(true);
    await dialog.screenshot({ path: join(dest, `google-${mode}-360-revocar.png`) });
    await page.keyboard.press('Enter'); await expect(panel.getByText('Sin conectar')).toBeVisible(); expect(revoke).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    failLoad = true; await page.reload();
    await expect(panel.getByText('GOOGLE_UNAVAILABLE · req-e2e-57')).toBeVisible();
    await panel.screenshot({ path: join(dest, `google-${mode}-360-error.png`) });
    failLoad = false; await panel.getByRole('button', { name: 'Reintentar' }).click();
    await expect(panel.getByText('Sin conectar')).toBeVisible();
    expect(reminderRequests).toBe(0);
  });
}
