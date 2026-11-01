import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { comoAdmin } from './como-admin';
import type { RetencionDto } from '../components/retencion-del-negocio';
import type { ConfigDto } from '../components/recordatorios-de-cita';
import type { CorridaDto } from '../components/evaluaciones';
import type { AvisosDto } from '../components/campana';
import type { AuditRow } from '@iaxti/ui/react';

// Las CINCO listas nombradas por #588, en ambos modos a 360 px. No confundir
// los otros cinco paneles medidos por #897 con los cinco de la issue original.
// Fixtures tipados: miden presentación, no simulan aprobación del backend.
const auth = JSON.parse(readFileSync(join(__dirname, '.auth.json'), 'utf8'));
const retencion: RetencionDto = { months: 24, cutoff: '2024-10-14', deferredUntil: null };
const recordatorios: ConfigDto = { recordatorios: { '24h': 'p1', '2h': null },
  plantillas: [{ id: 'p1', name: 'recordatorio_24h', variables: 2, body: 'Hola {{1}}, te esperamos {{2}}.' }], zona: 'America/Santiago', activo: true };
const corridas: CorridaDto[] = [
  { id: 'c2', provider: 'openai', model: 'gpt-5-mini', promptVersion: 'v3', caseCount: 12, casesMedidos: 12, score: 0.83, createdAt: '2026-10-13T12:00:00Z' },
  { id: 'c1', provider: 'openai', model: 'gpt-5-mini', promptVersion: 'v2', caseCount: 12, casesMedidos: 12, score: 0.76, createdAt: '2026-10-06T12:00:00Z' },
];
const avisos: AvisosDto = { unread: 3, items: [1, 2, 3].map((n) => ({ id: `aviso-${n}`, type: 'mention', title: `Te mencionaron en la conversación ${n}`, body: 'Revisa la respuesta pendiente del equipo.', link: '/bandeja', groupCount: 1, readAt: null, createdAt: '2026-10-16T12:00:00Z' })) };
const entradas: AuditRow[] = [1, 2, 3, 4, 5].map((id) => ({ id, actor: 'persona-de-prueba', actor_kind: 'user', action: 'contact.created', resource: 'contact', result: 'ok', occurred_at: '2026-10-16T12:00:00Z' }));

async function focoVisible(page: Page, control: Locator) {
  // Llegar con el teclado también es parte del criterio: focus() ocultaba
  // que Radix bloqueaba Tab en la campana y nadie alcanzaba sus acciones.
  for (let paso = 0; paso < 100; paso++) {
    if (await control.evaluate((el) => document.activeElement === el)) break;
    await page.keyboard.press('Tab');
  }
  await expect(control).toBeFocused();
  const foco = await control.evaluate((el) => ({ visible: el.matches(':focus-visible'), width: getComputedStyle(el).outlineWidth, style: getComputedStyle(el).outlineStyle, color: getComputedStyle(el).outlineColor }));
  expect(foco.visible).toBe(true);
  expect(parseFloat(foco.width)).toBeGreaterThanOrEqual(2);
  expect(foco.style).not.toBe('none');
  expect(foco.color).not.toBe('rgba(0, 0, 0, 0)');
}
const paneles = [
  // La retención es una configuración: months:null significa «sin límite»,
  // nunca una colección vacía. No se inventa un estado que el contrato no tiene.
  { nombre: 'retencion', titulo: 'Cuánto se guardan las conversaciones', pagina: '/ajustes/bandeja', ruta: '**/v1/settings/retencion', cuerpo: retencion, vacio: undefined },
  { nombre: 'recordatorios', titulo: 'Recordatorios de cita', pagina: '/agenda', ruta: '**/v1/agenda/recordatorios', cuerpo: recordatorios, vacio: { ...recordatorios, plantillas: [], recordatorios: { '24h': null, '2h': null } } },
  { nombre: 'evaluaciones', titulo: 'Evaluaciones del asistente', pagina: '/ajustes/ia/detalle', ruta: '**/v1/agents/*/evals', cuerpo: corridas, vacio: [] },
  { nombre: 'auditoria', titulo: 'El libro de tu cuenta', pagina: '/ajustes/auditoria', ruta: '**/v1/audit?*', cuerpo: { entries: entradas, nextCursor: null }, vacio: { entries: [], nextCursor: null } },
  { nombre: 'campana', titulo: 'Lista de avisos', pagina: '/', ruta: '**/v1/arranque', cuerpo: avisos, vacio: { items: [], unread: 0 } },
];

async function preparar(page: Page, modo: string) {
    await page.setViewportSize({ width: 360, height: 900 });
    await page.addInitScript(({ auth, modo }) => {
      localStorage.setItem('iaxti-tenant', auth.tableTenantId);
      localStorage.setItem('pulso-mode', modo);
      localStorage.setItem('sb-127-auth-token', JSON.stringify({ access_token: auth.accessToken,
        token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
        refresh_token: 'e2e', user: { id: auth.userId, aud: 'authenticated', email: 'supervisora@e2e.cl' } }));
    }, { auth, modo });
    await comoAdmin(page, auth);
}

for (const modo of ['dia', 'noche']) for (const panel of paneles) for (const estado of ['contenido', 'vacio']) {
  if (estado === 'vacio' && panel.vacio === undefined) continue;
  test(`${panel.nombre}: carga y ${estado} medidos, 360 px y foco (${modo})`, async ({ page }, testInfo) => {
    await preparar(page, modo);
    const asistente = { id: '00000000-0000-4000-8000-00000000a001', name: 'Vendedora', provider: 'openai', model: 'gpt-5-mini', objetivo: 'agendar_visita', defaultMode: 'assist', autonomousHours: {}, limits: {} };
    await page.route('**/v1/agents', (r) => r.fulfill({ json: [asistente] }));
    // El tabulado pasa por los campos vecinos que guardan al perder foco.
    // Responden por el mismo asistente de presentación, no uno inexistente
    // en Postgres que contaminaría la captura con un 404 ajeno a la medición.
    await page.route(`**/v1/agents/${asistente.id}`, (r) => r.fulfill({ json: { ...asistente, ...r.request().postDataJSON() } }));
    let liberar!: () => void;
    const espera = new Promise<void>((resolve) => { liberar = resolve; });
    await page.route(panel.ruta, async (r) => {
      let base = null;
      if (panel.nombre === 'campana') {
        const respuesta = await r.fetch();
        expect(respuesta.ok(), 'el arranque real debe responder antes de sustituir solo avisos').toBe(true);
        base = await respuesta.json();
      }
      await espera;
      const cuerpo = estado === 'vacio' ? panel.vacio : panel.cuerpo;
      await r.fulfill({ json: base ? { ...base, avisos: { estado: 'ok', dato: cuerpo } } : cuerpo });
    });
    try {
      await page.goto(panel.pagina);
      await expect(page.locator('html')).toHaveAttribute('data-mode', modo);
      if (panel.nombre === 'campana') {
        const campana = page.getByRole('button', { name: 'Avisos', exact: true });
        await focoVisible(page, campana);
        await campana.press('Enter');
      }
      const region = panel.nombre === 'auditoria'
        ? page.getByRole('table').locator('..')
        : page.getByRole('region', { name: panel.titulo }).first();
      const silueta = region.locator('.animate-pulse').first();
      await expect(silueta).toBeVisible();
      const antes = (await region.boundingBox())!;
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const colores = await silueta.evaluate((el) => {
        let padre = el.parentElement;
        while (padre && getComputedStyle(padre).backgroundColor === 'rgba(0, 0, 0, 0)') padre = padre.parentElement;
        return { barra: getComputedStyle(el).backgroundColor, fondo: padre ? getComputedStyle(padre).backgroundColor : '' };
      });
      expect(colores.barra).not.toBe('rgba(0, 0, 0, 0)');
      expect(colores.barra).not.toBe(colores.fondo);
      await region.screenshot({ path: testInfo.outputPath(`${panel.nombre}-${modo}-cargando.png`) });
      liberar();
      await expect(region.locator('.animate-pulse')).toHaveCount(0);
      const despues = (await region.boundingBox())!;
      const medidas = testInfo.outputPath('medidas.json');
      writeFileSync(medidas, JSON.stringify({ panel: panel.nombre, estado, modo, ancho: 360, tolerancia: 16, antes, despues, diferencia: Math.abs(antes.height - despues.height) }, null, 2));
      await testInfo.attach('medidas', { path: medidas, contentType: 'application/json' });
      expect(Math.abs(antes.height - despues.height), `${panel.nombre}: ${antes.height}px → ${despues.height}px`).toBeLessThanOrEqual(16);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (estado === 'vacio') await expect(region.locator('.pulso-empty')).toBeVisible();
      const control = estado === 'vacio' ? region.locator('button, a[href]').first() : panel.nombre === 'auditoria'
        ? page.getByRole('button', { name: 'Buscar', exact: true })
        : panel.nombre === 'campana' ? region.getByRole('menuitem').first() : region.getByRole('button').first();
      await focoVisible(page, control);
      // Tab pasa por campos vecinos que guardan al perder foco. Su aviso
      // transitorio caduca por el mecanismo real: no debe tapar la captura.
      if (panel.nombre === 'evaluaciones') await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);
      await region.screenshot({ path: testInfo.outputPath(`${panel.nombre}-${modo}-${estado}.png`) });
      if (panel.nombre === 'evaluaciones') {
        let terminar!: () => void;
        let pedidos = 0;
        let recargas = 0;
        // La medición ya está guardada: no debe desaparecer aunque su
        // antigua recarga fallaría. El DTO es el EvalRun serializado real.
        await page.route('**/v1/agents/*/evals', async (r) => {
          recargas++;
          await r.fulfill({ status: 500, json: { code: 'EVALS_FAILED', message: 'No se pudo recargar.', requestId: 'req_eval_recarga' } });
        });
        const pendiente = new Promise<void>((resolve) => { terminar = resolve; });
        await page.route('**/v1/agents/*/evaluate', async (r) => {
          pedidos++;
          await pendiente;
          await r.fulfill({ json: { ...corridas[0], id: 'c3', score: 0.93 } satisfies CorridaDto });
        });
        try {
          await region.getByRole('button', { name: 'Medir ahora' }).press('Enter');
          await expect(region.getByRole('button', { name: 'Midiendo…' })).toBeVisible();
          if (estado === 'vacio') await region.getByRole('button', { name: 'Midiendo…' }).press('Enter');
          expect(pedidos).toBe(1);
        } finally { terminar(); }
        await expect(region.getByRole('button', { name: 'Medir ahora' })).toBeVisible();
        await expect(region.getByText('93%', { exact: true })).toBeVisible();
        await expect(region.getByText('Todavía no se ha medido nada')).toHaveCount(0);
        if (estado === 'contenido') {
          await expect(region.getByText('83%', { exact: true })).toBeVisible();
          await expect(region.getByText('+10 puntos vs. la anterior', { exact: true })).toBeVisible();
        }
        expect(recargas).toBe(0);
      }
    } finally { liberar(); }
  });
}

async function arranqueConAvisos(page: Page, pieza: unknown) {
  await page.route('**/v1/arranque', async (r) => {
    const respuesta = await r.fetch();
    expect(respuesta.ok()).toBe(true);
    const base = await respuesta.json();
    await r.fulfill({ json: { ...base, avisos: pieza } });
  });
}

for (const modo of ['dia', 'noche']) {
  test(`campana: fallo y recuperación por teclado, sin navegación silenciosa (${modo})`, async ({ page }, testInfo) => {
    await preparar(page, modo);
    await arranqueConAvisos(page, { estado: 'ok', dato: avisos });
    await page.route('**/v1/notifications', (r) => r.fulfill({ json: avisos }));
    let liberar!: () => void;
    const pendiente = new Promise<void>((resolve) => { liberar = resolve; });
    let intentos = 0;
    await page.route('**/v1/notifications/read', async (r) => {
      intentos++;
      if (intentos === 1) {
        await pendiente;
        await r.fulfill({ status: 500, json: { code: 'READ_FAILED', message: 'No pudimos marcar el aviso.', requestId: 'req_click' } });
      } else await r.fulfill({ json: {} });
    });
    try {
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('data-mode', modo);
      const campana = page.getByRole('button', { name: 'Avisos, 3 sin leer' });
      await focoVisible(page, campana);
      await campana.press('Enter');
      const region = page.getByRole('region', { name: 'Lista de avisos' });
      const enlace = region.getByRole('menuitem').first();
      await expect(enlace).toHaveAttribute('href', '/bandeja');
      await focoVisible(page, enlace);
      await enlace.press('Enter');
      await expect.poll(() => intentos).toBe(1);
      await expect(page).toHaveURL('/');
      liberar();
      await expect(region).toContainText('READ_FAILED · req_click');
      await expect(page).toHaveURL('/');
      await expect(enlace).toBeVisible();
      await region.screenshot({ path: testInfo.outputPath(`campana-${modo}-fallo-al-marcar.png`) });
      await focoVisible(page, enlace);
      await enlace.press('Enter');
      await expect(page).toHaveURL('/bandeja');
      expect(intentos).toBe(2);
    } finally { liberar(); }
  });

  test(`campana: el fallo de carga ofrece Copiar y Reintentar por teclado (${modo})`, async ({ page }, testInfo) => {
    await preparar(page, modo);
    await arranqueConAvisos(page, { estado: 'falla' });
    let recuperado = false;
    await page.route('**/v1/notifications', (r) => r.fulfill(recuperado ? { json: avisos } : {
      status: 500, json: { code: 'LOAD_FAILED', message: 'No pudimos leer los avisos.', requestId: 'req_keyboard' },
    }));
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-mode', modo);
    const campana = page.getByRole('button', { name: 'Avisos', exact: true });
    await focoVisible(page, campana);
    await campana.press('Enter');
    const region = page.getByRole('region', { name: 'Lista de avisos' });
    await expect(region).toContainText('LOAD_FAILED · req_keyboard');
    await focoVisible(page, region.getByRole('button', { name: 'Copiar' }));
    await page.keyboard.press('Tab');
    await expect(region.getByRole('button', { name: 'Reintentar' })).toBeFocused();
    await focoVisible(page, region.getByRole('button', { name: 'Reintentar' }));
    await region.screenshot({ path: testInfo.outputPath(`campana-${modo}-fallo-al-cargar.png`) });
    recuperado = true;
    await page.keyboard.press('Enter');
    await expect(region.getByRole('menuitem')).toHaveCount(3);
    await expect(region).not.toContainText('LOAD_FAILED');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Avisos, 3 sin leer' })).toBeFocused();
  });
}

for (const status of [500, 403]) {
  test(`campana: no navega si el refresco tras marcar devuelve ${status}`, async ({ page }) => {
    await preparar(page, 'dia');
    await arranqueConAvisos(page, { estado: 'ok', dato: avisos });
    await page.route('**/v1/notifications/read', (r) => r.fulfill({ json: {} }));
    await page.route('**/v1/notifications', (r) => r.fulfill({ status,
      json: { code: status === 403 ? 'FORBIDDEN' : 'REFRESH_FAILED', message: 'No pudimos actualizar los avisos.', requestId: 'req_refresh' },
    }));
    await page.goto('/');
    const campana = page.getByRole('button', { name: 'Avisos, 3 sin leer' });
    await focoVisible(page, campana);
    await campana.press('Enter');
    const region = page.getByRole('region', { name: 'Lista de avisos' });
    await focoVisible(page, region.getByRole('menuitem').first());
    await page.keyboard.press('Enter');
    await expect(region).toContainText(status === 403 ? 'No tienes permiso' : 'REFRESH_FAILED · req_refresh');
    await expect(page).toHaveURL('/');
    await expect(region.getByRole('menuitem')).toHaveCount(status === 403 ? 0 : 3);
    await expect(region.getByRole('button', { name: 'Reintentar' })).toHaveCount(status === 403 ? 0 : 1);
  });
}

test('campana: Ctrl+clic conserva la pestaña actual y muestra allí el fallo', async ({ page, context }) => {
  await preparar(page, 'dia');
  await arranqueConAvisos(page, { estado: 'ok', dato: avisos });
  await page.route('**/v1/notifications/read', (r) => r.fulfill({ status: 500,
    json: { code: 'READ_FAILED', message: 'No pudimos marcar el aviso.', requestId: 'req_newtab' },
  }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Avisos, 3 sin leer' }).click();
  const region = page.getByRole('region', { name: 'Lista de avisos' });
  const nueva = context.waitForEvent('page');
  await region.getByRole('menuitem').first().click({ modifiers: ['Control'] });
  const otra = await nueva;
  // Se comprueba que el navegador abre el destino en OTRA pestaña. Esperar
  // su documento completo mezclaba esto con la carga de Bandeja: la traza ya
  // tenía GET 200 y navegación a /bandeja pero toHaveURL seguía esperando.
  await otra.waitForURL('**/bandeja', { waitUntil: 'commit' });
  expect(otra.url()).toBe(new URL('/bandeja', page.url()).href);
  await expect(page).toHaveURL('/');
  await expect(region).toContainText('READ_FAILED · req_newtab');
  await otra.close();
});
