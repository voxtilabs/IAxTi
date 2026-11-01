import { expect, test, type Page, type Locator } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// UI con respuestas sintéticas: los contratos HTTP/RLS/proveedor se ejercitan
// por separado en api/tests/canales-meta-74.test.ts. Aquí no sale ningún envío.
const auth = JSON.parse(readFileSync(join(__dirname, '.auth.json'), 'utf8'));
const evidencias = join(__dirname, '../../..', 'docs/evidencias/74');
const opciones = [
  { senderId: 'sender-ficticio-74', kind: 'instagram', name: 'Tienda de prueba' },
  { senderId: 'sender-ficticio-74', kind: 'messenger', name: 'Página de prueba' },
];
async function focoConTab(page: Page, control: Locator) {
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press('Tab');
    if (await control.evaluate((e) => e === document.activeElement)) break;
  }
  await expect(control).toBeFocused();
  const estilo = await control.evaluate((e) => {
    const s = getComputedStyle(e); return { outline: s.outlineStyle, shadow: s.boxShadow };
  });
  expect(estilo.outline !== 'none' || estilo.shadow !== 'none').toBe(true);
  return estilo;
}
for (const modo of ['dia', 'noche']) {
  test(`Canales Meta a 360 px en ${modo}: estados, teclado y conexión`, async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 900 });
    await page.addInitScript(({ auth, modo }) => {
      localStorage.setItem('pulso-mode', modo);
      localStorage.setItem('iaxti-tenant', auth.tableTenantId);
      localStorage.setItem('sb-127-auth-token', JSON.stringify({ access_token: auth.accessToken, token_type: 'bearer', expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'e2e', user: { id: auth.userId, aud: 'authenticated', email: 'canales@e2e.cl' } }));
    }, { auth, modo });
    let liberar!: () => void;
    const espera = new Promise<void>((r) => { liberar = r; });
    let estado = 'carga';
    await page.route('**/v1/channels/conexiones-disponibles', async (route) => {
      if (estado === 'carga') { await espera; }
      if (estado === 'falla') return route.fulfill({ status: 503, json: { code: 'PROVIDER_UNAVAILABLE', message: 'No pudimos comprobar el emisor. Intenta de nuevo.', requestId: 'req_visual_74' } });
      if (estado === 'sin-permiso') return route.fulfill({ status: 403, json: { code: 'PERMISSION_DENIED', message: 'Sin permiso.', requestId: 'req_permiso_74' } });
      return route.fulfill({ json: estado === 'vacio' ? [] : opciones });
    });
    await page.route('**/v1/channels/conectar', async (route) => {
      expect(route.request().postDataJSON()).toEqual({ senderId: opciones[0].senderId, kind: 'instagram' });
      await route.fulfill({ status: 201, json: { id: 'cuenta-ficticia-74', kind: 'instagram', name: 'Tienda de prueba', state: 'active' } });
    });
    await page.route('**/v1/channels/cuenta-ficticia-74/diagnostico', (route) => route.fulfill({ status: 503, json: { code: 'PROVIDER_UNAVAILABLE', message: 'Diagnóstico simulado.', requestId: 'req_diag_74' } }));
    await page.goto('/ajustes/canales');
    await expect(page.locator('html')).toHaveAttribute('data-mode', modo);
    const panel = page.getByRole('region', { name: 'Conectar Instagram y Messenger' });
    await expect(panel.getByRole('status', { name: 'Buscando conexiones' })).toBeVisible();
    mkdirSync(evidencias, { recursive: true });
    const carga = (await panel.boundingBox())!;
    await panel.screenshot({ path: join(evidencias, `conexion-${modo}-carga.png`) });
    estado = 'lista'; liberar();
    const boton = panel.getByRole('button', { name: 'Conectar Instagram' });
    await expect(boton).toBeVisible();
    const lista = (await panel.boundingBox())!;
    const foco = await focoConTab(page, boton);
    await panel.screenshot({ path: join(evidencias, `conexion-${modo}-lista-foco.png`) });
    await page.keyboard.press('Enter');
    await expect(panel.getByRole('button', { name: 'Conectar Instagram' })).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Identificador del contacto para la prueba' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Identificador del contacto para la prueba' }).fill('17841400000000000');
    await page.locator('text=Probar el envío').first().locator('..').screenshot({ path: join(evidencias, `conexion-${modo}-prueba-id.png`) });
    estado = 'vacio'; await page.reload();
    await expect(panel.getByText('No hay conexiones pendientes')).toBeVisible();
    const vacio = (await panel.boundingBox())!;
    await focoConTab(page, panel.getByRole('button', { name: 'Volver a comprobar' }));
    await panel.screenshot({ path: join(evidencias, `conexion-${modo}-vacio.png`) });
    estado = 'falla'; await page.keyboard.press('Enter');
    await expect(panel.getByText('PROVIDER_UNAVAILABLE · req_visual_74')).toBeVisible();
    await focoConTab(page, panel.getByRole('button', { name: 'Reintentar' }));
    await panel.screenshot({ path: join(evidencias, `conexion-${modo}-falla.png`) });
    estado = 'sin-permiso'; await page.keyboard.press('Enter');
    await expect(panel.getByText(/Necesitas permiso/)).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Reintentar' })).toHaveCount(0);
    await panel.screenshot({ path: join(evidencias, `conexion-${modo}-sin-permiso.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    expect(Math.abs(lista.height - carga.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(vacio.height - carga.height)).toBeLessThanOrEqual(1);
    writeFileSync(join(evidencias, `medidas-${modo}.json`), JSON.stringify({ viewport: 360, carga, lista, vacio, foco }, null, 2));
  });
}

/**
 * Y el panel tampoco salta en las pantallas anchas (#1157).
 *
 * La prueba de arriba mide a 360 px, y el piso que la mantenía verde era UNO
 * solo: los 383,6 px que ocupa el estado vacío cuando su texto envuelve en
 * seis líneas. En escritorio el mismo texto entra en tres, el estado más alto
 * mide 262, y el piso dejaba 122 px de nada debajo del contenido. Se veía en
 * la captura de `/ajustes/canales` y parecía un panel roto.
 *
 * Así que el piso ahora es uno por tramo, y la afirmación «los estados miden
 * lo mismo» hay que comprobarla en cada tramo o el piso de escritorio queda
 * sin vigilar. Esta prueba no saca capturas ni recorre el teclado: solo mide,
 * que es lo que le faltaba a la otra.
 */
for (const ancho of [360, 640, 768, 1024, 1280]) {
  test(`Canales Meta a ${ancho} px: los estados miden lo mismo`, async ({ page }) => {
    await page.setViewportSize({ width: ancho, height: 900 });
    await page.addInitScript((a) => {
      localStorage.setItem('pulso-mode', 'dia');
      localStorage.setItem('iaxti-tenant', a.tableTenantId);
      localStorage.setItem('sb-127-auth-token', JSON.stringify({
        access_token: a.accessToken, token_type: 'bearer', expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'e2e',
        user: { id: a.userId, aud: 'authenticated', email: 'canales@e2e.cl' },
      }));
    }, auth);

    let liberar!: () => void;
    const espera = new Promise<void>((r) => { liberar = r; });
    let estado = 'carga';
    await page.route('**/v1/channels/conexiones-disponibles', async (route) => {
      if (estado === 'carga') await espera;
      if (estado === 'falla') {
        return route.fulfill({ status: 503, json: { code: 'PROVIDER_UNAVAILABLE', message: 'No pudimos comprobar el emisor. Intenta de nuevo.', requestId: 'req_ancho_74' } });
      }
      return route.fulfill({ json: estado === 'vacio' ? [] : opciones });
    });

    await page.goto('/ajustes/canales');
    const panel = page.getByRole('region', { name: 'Conectar Instagram y Messenger' });
    await expect(panel.getByRole('status', { name: 'Buscando conexiones' })).toBeVisible();
    const carga = (await panel.boundingBox())!.height;

    estado = 'lista'; liberar();
    await expect(panel.getByRole('button', { name: 'Conectar Instagram' })).toBeVisible();
    const lista = (await panel.boundingBox())!.height;
    // El aire que queda DEBAJO del contenido, en el estado más alto —que es
    // este—. Se mide acá y no al final porque medirlo en un estado corto
    // diría «sobra» de un piso que está bien puesto.
    const sobra = await panel.evaluate((sec) => {
      const ultimo = sec.lastElementChild;
      if (!ultimo) return 0;
      return Math.round(sec.getBoundingClientRect().bottom - ultimo.getBoundingClientRect().bottom);
    });

    estado = 'vacio'; await page.reload();
    await expect(panel.getByText('No hay conexiones pendientes')).toBeVisible();
    const vacio = (await panel.boundingBox())!.height;

    estado = 'falla';
    await panel.getByRole('button', { name: 'Volver a comprobar' }).click();
    await expect(panel.getByText(/PROVIDER_UNAVAILABLE/)).toBeVisible();
    const falla = (await panel.boundingBox())!.height;

    for (const [nombre, alto] of [['lista', lista], ['vacío', vacio], ['fallando', falla]] as const) {
      expect(
        Math.abs(alto - carga),
        `a ${ancho} px el panel mide ${carga} cargando y ${alto} ${nombre}: ajustá el piso del tramo`,
      ).toBeLessThanOrEqual(1);
    }
    // Y el piso no sobra. Dos cosas que me costó acertar:
    //
    // Se mide el aire debajo del último hijo y NO la altura del panel: el
    // piso clampea todos los estados por igual, así que comparar un estado
    // con otro no puede detectar un piso de más. Lo escribí mal primero
    // —`carga < vacio + 20`— y la mordida del piso único pasó verde.
    //
    // Se exige en TODOS los anchos y no solo al arranque del tramo: el estado
    // más alto es el de la lista, y su altura no depende del ancho dentro de
    // un tramo —355,5 de 360 a 639; 239,5 de 640 para arriba—, así que el
    // piso puede calzar en todos lados. Si un día alguien mete ahí un texto
    // que envuelve distinto según el ancho, esto se pone rojo y hay que
    // decidirlo, que es lo que se quiere.
    // 16 del `p-4` de abajo, más 20 de tolerancia.
    expect(sobra, `a ${ancho} px sobran ${sobra} px debajo del contenido`).toBeLessThanOrEqual(36);
  });
}
