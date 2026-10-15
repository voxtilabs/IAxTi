import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { comoAdmin } from './como-admin';
import type { Franja } from '../components/horarios-de-atencion';
import type { RetencionDto } from '../components/retencion-del-negocio';
import type { ConfigDto } from '../components/recordatorios-de-cita';
import type { CorridaDto } from '../components/evaluaciones';
import type { TasaDto } from '../components/logro-del-objetivo';
import { join } from 'node:path';

/**
 * «Ningún esqueleto de alto distinto al del contenido: medido, no a ojo»
 * (#588, criterio de aceptación 4).
 *
 * Cinco paneles de Ajustes y Agenda hacían `return null` mientras cargaban, y
 * la pantalla se dibujaba sin ellos: cuando llegaban los datos aparecían de
 * golpe y empujaban hacia abajo todo lo que ya estaba. El salto no es solo
 * fealdad, mueve el botón que alguien estaba por tocar.
 *
 * ## Cómo mide, y por qué así
 *
 * Demora la petición y la contesta con un cuerpo propio. Lo primero que
 * intenté fue dejar pasar la real, para medir contra los datos sembrados: no
 * se puede, porque el usuario del e2e NO tiene los permisos de estos cinco
 * paneles —`tenant.settings`, `calendar.read`, `agents.configure`— y las cinco
 * rutas contestan 403. Medir el alto del estado «sin permiso» no es medir el
 * alto del contenido.
 *
 * La objeción a un simulacro es que envejece: el DTO cambia y la prueba sigue
 * midiendo contra la forma vieja, en verde. Acá eso se cierra con el tipo —los
 * cuerpos están tipados con los DTO que exportan los propios componentes, así
 * que un campo que cambia rompe la COMPILACIÓN de esta prueba—. Lo que el
 * simulacro no puede garantizar es el realismo del contenido: tres franjas
 * ocupan más que una, y por eso cada cuerpo elige un caso típico y lo dice.
 *
 * Los dos estados se encuentran con el MISMO locator porque comparten el
 * `aria-label`, y se distinguen por `aria-busy`. Eso es lo que hace que esto
 * sea una medición y no dos mediciones de cosas distintas.
 *
 * ## La tolerancia
 *
 * 16 px: menos de una línea de texto. Más que eso ya se nota como salto, y
 * menos sería pedirle al esqueleto que adivine el alto exacto de un contenido
 * que depende de los datos —tres franjas horarias ocupan más que una—. Lo que
 * se persigue no es el píxel, es que no se mueva lo de abajo.
 *
 * Si un panel no llega a cargar, la prueba FALLA diciéndolo: un `skip`
 * silencioso acá dejaría el criterio «medido» cumplido en el papel y sin
 * medir nada.
 *
 * ## Lo que se agregó después
 *
 * El archivo se llama por el esqueleto porque nació para medirlo, pero al
 * final cubre las cuatro ramas de una carga: el esqueleto, el día y la noche
 * a 360 px, el 403 que NO ofrece reintentar y la caída que sí, con su
 * `code · requestId` (#788). Las cuatro son la misma pregunta —qué ve alguien
 * mientras y cuando algo no sale— y separarlas en archivos distintos haría
 * que la próxima pantalla copiara una y se olvidara de las otras tres.
 */

const auth = JSON.parse(readFileSync(join(__dirname, '.auth.json'), 'utf8'));
const TOLERANCIA = 16;
const DEMORA = 2_000;

test.beforeEach(async ({ page }) => {
  await page.addInitScript((auth) => {
    localStorage.setItem('iaxti-tenant', auth.tenantId);
    localStorage.setItem('sb-127-auth-token', JSON.stringify({ access_token: auth.accessToken,
      token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: 'e2e', user: { id: auth.userId, aud: 'authenticated', email: 'supervisora@e2e.cl' } }));
  }, auth);
});

/** Un negocio que atiende de lunes a viernes: cinco franjas, el caso típico. */
const FRANJAS: Franja[] = [1, 2, 3, 4, 5].map((weekday) => ({
  id: `f${weekday}`, weekday, inicio: '09:00', fin: '18:00',
  duracion: 30, respiro: 10, anticipacion: 60,
}));

const RETENCION: RetencionDto = { months: 24, cutoff: '2024-10-14', deferredUntil: null };

const RECORDATORIOS: ConfigDto = {
  recordatorios: { '24h': 'p1', '2h': null },
  plantillas: [{ id: 'p1', name: 'recordatorio_24h', variables: 2, body: 'Hola {{1}}, te esperamos {{2}}.' }],
  zona: 'America/Santiago', activo: true,
};

/** Dos corridas, que es lo que hace falta para que se vea el «vs. la anterior». */
const CORRIDAS: CorridaDto[] = [
  { id: 'c2', provider: 'openai', model: 'gpt-5-mini', promptVersion: 'v3',
    caseCount: 12, casesMedidos: 12, score: 0.83, createdAt: '2026-10-13T12:00:00Z' },
  { id: 'c1', provider: 'openai', model: 'gpt-5-mini', promptVersion: 'v2',
    caseCount: 12, casesMedidos: 12, score: 0.76, createdAt: '2026-10-06T12:00:00Z' },
];

const TASA: TasaDto = {
  objetivo: 'agendar_visita', cerrados: 18, pendientes: 4, porElAgente: 11, asistidos: 7,
  perdidos: 3, tasaDelAgente: 0.61, tasaConAsistencia: 0.78, horasHastaElLogro: 5.5,
  porEvento: [{ evento: 'cita.agendada', n: 11 }], fueraDeVentana: 1,
};

/**
 * Un asistente, porque sin él no hay nada que medir.
 *
 * El tenant del e2e no tiene asistentes, así que los dos paneles de Ajustes →
 * IA no se dibujan: su carga ni se intenta. Eso ya es el comportamiento
 * correcto —y de hecho esta medición fue la que encontró que ANTES se quedaban
 * con el esqueleto puesto para siempre, confundiendo «no hay asistente» con
 * «está cargando»—, pero para medir el alto del contenido hace falta que haya
 * contenido.
 */
const ASISTENTES = [
  { id: '00000000-0000-4000-8000-00000000a001', name: 'Vendedora', provider: 'openai', model: 'gpt-5-mini', objetivo: 'agendar_visita' },
];

const PANELES: Array<{
  titulo: string; pantalla: string; ruta: string; cuerpo: unknown;
  /** Rutas que hay que contestar ANTES, sin demora, para que el panel exista. */
  previas?: Array<{ ruta: string; cuerpo: unknown }>;
}> = [
  { titulo: 'Cuánto se guardan las conversaciones', pantalla: '/ajustes/bandeja', ruta: '**/v1/settings/retencion', cuerpo: RETENCION },
  { titulo: 'Horario de atención', pantalla: '/agenda', ruta: '**/v1/agenda/disponibilidad', cuerpo: FRANJAS },
  { titulo: 'Recordatorios de cita', pantalla: '/agenda', ruta: '**/v1/agenda/recordatorios', cuerpo: RECORDATORIOS },
  { titulo: 'Evaluaciones del asistente', pantalla: '/ajustes/ia', ruta: '**/v1/agents/*/evals', cuerpo: CORRIDAS,
    previas: [{ ruta: '**/v1/agents', cuerpo: ASISTENTES }] },
  { titulo: 'Logro del objetivo', pantalla: '/ajustes/ia', ruta: '**/v1/agents/*/objetivo', cuerpo: TASA,
    previas: [{ ruta: '**/v1/agents', cuerpo: ASISTENTES }] },
];

async function alto(page: Page, titulo: string): Promise<number> {
  const caja = await page.getByRole('region', { name: titulo }).first().boundingBox();
  expect(caja, `no se pudo medir «${titulo}»`).not.toBeNull();
  return caja!.height;
}

for (const panel of PANELES) {
  test(`el esqueleto de «${panel.titulo}» tiene el alto del contenido`, async ({ page }) => {
    // Los cinco paneles viven en pantallas de configuración, o sea de ADMIN.
    // Hasta #815 daba igual —la pantalla se dibujaba sin el permiso— y estas
    // pruebas medían el alto de algo que la usuaria del seed no podía ver.
    await comoAdmin(page, auth);
    for (const previa of panel.previas ?? []) {
      await page.route(previa.ruta, (r) => r.fulfill({ json: previa.cuerpo }));
    }
    await page.route(panel.ruta, async (r) => {
      // `fulfill` y NO `continue()`: con `continue()` la petición a la API
      // —que es otro origen— no volvía nunca y los cinco paneles quedaban con
      // el esqueleto puesto para siempre. `fulfill` es además el patrón que ya
      // usan `bandeja-scroll` y `reportes-rendimiento`.
      await new Promise((listo) => setTimeout(listo, DEMORA));
      await r.fulfill({ json: panel.cuerpo });
    });
    await page.goto(panel.pantalla);

    const region = page.getByRole('region', { name: panel.titulo }).first();
    // El esqueleto: mismo nombre accesible, `aria-busy` puesto.
    await expect(region).toHaveAttribute('aria-busy', 'true');
    const esqueleto = await alto(page, panel.titulo);

    // Y el contenido, cuando la petición demorada por fin vuelve.
    await expect(region).not.toHaveAttribute('aria-busy', 'true', { timeout: DEMORA + 10_000 });
    const contenido = await alto(page, panel.titulo);

    expect(
      Math.abs(esqueleto - contenido),
      `esqueleto ${esqueleto}px vs contenido ${contenido}px: ajustá el \`alto\` del PanelCargando`,
    ).toBeLessThanOrEqual(TOLERANCIA);
  });
}

/**
 * Día y noche a 360 px (#588, criterio de aceptación 5).
 *
 * El criterio pide los dos modos y el ancho chico en cada pantalla que se
 * toque, y un esqueleto es una pantalla más: si una barra se sale del ancho,
 * la silueta aparece con barra de scroll horizontal y después se va, que es un
 * salto distinto del mismo defecto.
 *
 * Se mide sobre el horario de atención porque es el más alto de los cinco
 * —798 px repartidos en cinco barras—: el que tiene más superficie para
 * desbordar.
 */
for (const modo of ['dia', 'noche']) {
  test(`el esqueleto a 360 px en ${modo} no desborda ni se pierde en el fondo`, async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 900 });
    await comoAdmin(page, auth);
    await page.route('**/v1/agenda/disponibilidad', async (r) => {
      await new Promise((listo) => setTimeout(listo, DEMORA));
      await r.fulfill({ json: FRANJAS });
    });
    await page.goto('/agenda');
    await page.evaluate((modo) => document.documentElement.setAttribute('data-mode', modo), modo);

    const region = page.getByRole('region', { name: 'Horario de atención' }).first();
    await expect(region).toHaveAttribute('aria-busy', 'true');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    // Y que la silueta se VEA: `bg-rest` sobre el fondo del modo. Un esqueleto
    // del mismo color que su fondo ocupa el lugar correcto y no comunica nada.
    const colores = await region.evaluate((seccion) => {
      const barra = seccion.querySelector('div > div');
      return {
        barra: getComputedStyle(barra as Element).backgroundColor,
        fondo: getComputedStyle(seccion).backgroundColor,
      };
    });
    expect(colores.barra).not.toBe(colores.fondo);
    expect(colores.barra).not.toBe('rgba(0, 0, 0, 0)');
  });
}

/**
 * Sin el permiso la pantalla NO se dibuja, y lo que aparece tampoco ofrece
 * reintentar (#788 y #815).
 *
 * Esta prueba cambió de sujeto con #815, y vale la pena contar por qué. Antes
 * entraba a `/ajustes/bandeja` con la usuaria del seed —SUPERVISOR, sin
 * `tenant.settings`—, la pantalla se dibujaba igual, y lo que comprobaba era
 * que el PANEL de retención no ofreciera «Reintentar» al recibir el 403 de su
 * propia petición.
 *
 * Eso era medir el segundo piso con la puerta de abajo abierta: la pantalla no
 * tenía por qué estar ahí. #815 tapó el agujero —el shell ya no monta una
 * pantalla cuyo permiso no tenés— así que acá se afirma lo que de verdad
 * importa: que la puerta cierra, y que lo que se ve en su lugar no es un botón
 * que no puede funcionar.
 *
 * Nada de esto se simula: esta usuaria no tiene `tenant.settings` ni
 * `calendar.read` de verdad.
 */
test('sin el permiso, la pantalla no se dibuja ni ofrece reintentar', async ({ page }) => {
  await page.goto('/ajustes/bandeja');
  await expect(
    page.getByRole('region', { name: 'Cuánto se guardan las conversaciones' }),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reintentar' })).toHaveCount(0);

  await page.goto('/agenda');
  await expect(page.getByRole('region', { name: 'Horario de atención' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reintentar' })).toHaveCount(0);
});

/**
 * Y el 403 de un PANEL se prueba donde sigue ocurriendo: dentro de una
 * pantalla que la persona sí puede abrir.
 *
 * Pasa en dos casos reales: cuando el permiso de la sección y el del panel no
 * son el mismo, y cuando a alguien le quitan un permiso a mitad de sesión —el
 * arranque se pide una vez por sesión y negocio, así que el navegador le sigue
 * diciendo que lo tiene—. Acá sí se simula la respuesta, porque es un estado
 * que no se puede provocar con una cuenta fija.
 */
test('un 403 de un panel, dentro de una pantalla que sí se abre, no ofrece reintentar', async ({ page }) => {
  await comoAdmin(page, auth);
  await page.route('**/v1/settings/retencion', (r) =>
    r.fulfill({
      status: 403,
      json: { code: 'FORBIDDEN', message: 'No tienes permiso para esto.', requestId: 'req_pruebita' },
    }),
  );
  await page.goto('/ajustes/bandeja');
  const retencion = page.getByRole('region', { name: 'Cuánto se guardan las conversaciones' });
  await expect(retencion).toBeVisible();
  await expect(retencion.getByRole('button', { name: 'Reintentar' })).toHaveCount(0);
  // Y no muestra el mensaje crudo del servidor: sin permiso, la sección
  // simplemente no ofrece nada (la convención de los widgets del inicio).
  await expect(retencion).not.toContainText('No tienes permiso para esto.');
});

test('una caída sí ofrece reintentar, con el identificador para pedir ayuda', async ({ page }) => {
  await comoAdmin(page, auth);
  await page.route('**/v1/settings/retencion', (r) =>
    r.fulfill({
      status: 500,
      json: { code: 'INTERNAL', message: 'No pudimos leer la retención.', requestId: 'req_pruebita' },
    }),
  );
  await page.goto('/ajustes/bandeja');
  const retencion = page.getByRole('region', { name: 'Cuánto se guardan las conversaciones' });
  await expect(retencion).toContainText('No pudimos leer la retención.');
  // `code · requestId` (#659): el dato con el que alguien puede ir a buscar en
  // los registros qué pasó. Es lo que `err.message` tiraba a la basura.
  await expect(retencion).toContainText('INTERNAL · req_pruebita');
  await expect(retencion.getByRole('button', { name: 'Reintentar' })).toBeVisible();
  await expect(retencion.getByRole('button', { name: 'Copiar' })).toBeVisible();
});

/**
 * La pantalla sigue al selector de negocio (#789).
 *
 * El defecto era `useEffect(() => setTenant(selectedTenant()), [])`: corre UNA
 * vez al montar, así que si `localStorage` todavía no tenía el negocio en ese
 * instante —primer login, o la carrera con el selector— la pantalla se quedaba
 * sin negocio PARA SIEMPRE, y al cambiar de negocio seguía mostrando los datos
 * del anterior. Lo segundo es peor que un hueco: son los datos de un cliente
 * bajo el nombre de otro.
 *
 * Se prueba por el evento y no cambiando de negocio en el selector, porque lo
 * que hay que verificar es que la pantalla ESCUCHE: el selector dispara
 * `iaxti-tenant-changed` y eso es todo lo que recibe. Si la pantalla no
 * escucha, este disparo no hace nada y la petición nueva nunca sale.
 */
test('al cambiar de negocio, la pantalla vuelve a preguntar', async ({ page }) => {
  await comoAdmin(page, auth);
  const pedidos: string[] = [];
  await page.route('**/v1/settings/retencion', (r) => {
    pedidos.push(r.request().headers()['x-tenant-id'] ?? '');
    return r.fulfill({ json: { months: 24, cutoff: null, deferredUntil: null } });
  });
  await page.goto('/ajustes/bandeja');
  await expect(page.getByRole('region', { name: 'Cuánto se guardan las conversaciones' })).toBeVisible();
  expect(pedidos).toHaveLength(1);

  // El otro negocio, y el aviso que da el selector.
  await page.evaluate(() => {
    localStorage.setItem('iaxti-tenant', '00000000-0000-4000-8000-00000000b002');
    window.dispatchEvent(new Event('iaxti-tenant-changed'));
  });
  /**
   * Lo que se afirma es que SALIÓ una petición por el negocio nuevo, no un
   * total de peticiones.
   *
   * Escrita contra el total daba tres, y la tercera enseñó algo: el selector
   * de negocio también escucha el evento, ve que este id no es de los que
   * este usuario tiene, y lo devuelve al válido. O sea que la pantalla siguió
   * los DOS cambios —el falso y la corrección—, que es exactamente lo que
   * tiene que hacer. Contar peticiones habría convertido ese acierto en rojo.
   */
  await expect(async () => {
    expect(pedidos).toContain('00000000-0000-4000-8000-00000000b002');
  }).toPass({ timeout: 5_000 });
  // Y la primera fue por el negocio de la sesión, no por el inventado.
  expect(pedidos[0]).not.toBe('00000000-0000-4000-8000-00000000b002');
});
