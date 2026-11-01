import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * El tablero de oportunidades cabe en la ventana (#1155).
 *
 * Medido antes de esto como ADMIN, con veinte oportunidades en la primera
 * etapa y una ventana de 900 px de alto: la página media **6.329 px**. Las
 * columnas crecen con sus tarjetas y nada acota el alto, así que scrollea la
 * PÁGINA: la cabecera de la etapa —su nombre y su total— se va para arriba y
 * dejás de saber qué columna estás mirando. También usaba 1.120 px de ancho
 * de los 1.400 disponibles, encajonada en el contenedor de las pantallas de
 * formulario.
 *
 * Se mide el scroll y no la apariencia porque con pocas oportunidades el
 * defecto no se ve: hace falta llenar una columna para que aparezca. Y se
 * mide la CABECERA además del alto: acotar la página sin mover el
 * `overflow` al cuerpo de la columna deja la cabecera quieta pero las
 * tarjetas inalcanzables, que es peor.
 */
const auth = JSON.parse(readFileSync(join(__dirname, '.auth.json'), 'utf8'));

const DEALS = Array.from({ length: 30 }, (_, i) => ({
  id: `deal-${i}`, title: `Oportunidad de prueba número ${i + 1}`,
  contactId: `c-${i}`, contactName: `Contacto ${i + 1}`, contactPhone: '+56900000000',
  stageId: 'etapa-1', stageName: 'Nuevo', status: 'open', stalled: false,
  value: null, valueClp: 150_000, currency: 'CLP', createdAt: '2026-10-01T12:00:00.000Z',
}));

test.beforeEach(async ({ page }) => {
  await page.addInitScript((a) => {
    localStorage.setItem('iaxti-tenant', a.tenantId);
    localStorage.setItem('pulso-mode', 'dia');
    localStorage.setItem('sb-127-auth-token', JSON.stringify({
      access_token: a.accessToken, token_type: 'bearer', expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'e2e',
      user: { id: a.userId, aud: 'authenticated', email: 'admin@e2e.cl' },
    }));
  }, auth);
  await page.route('**/v1/pipelines', (r) => r.fulfill({ json: [{
    id: 'emb-1', name: 'Ventas', stages: [
      { id: 'etapa-1', name: 'Nuevo', type: 'open', position: 1 },
      { id: 'etapa-2', name: 'Cotizado', type: 'open', position: 2 },
      { id: 'etapa-3', name: 'Ganado', type: 'won', position: 3 },
    ],
  }] }));
  // Expresiones regulares y no globs: en un glob de Playwright el `?` es un
  // comodín de un carácter, así que `**/v1/deals?**` también capturaba
  // `/v1/deals/resumen?...` y el orden de registro decidía cuál ganaba.
  await page.route(/\/v1\/deals\/resumen\b/, (r) => r.fulfill({ json: { items: [
    { stageId: 'etapa-1', cuantas: 137, totalClp: 20_550_000 },
    { stageId: 'etapa-2', cuantas: 4, totalClp: 900_000 },
  ] } }));
  await page.route(/\/v1\/deals\?/, (r) => {
    const url = new URL(r.request().url());
    const items = url.searchParams.get('stageId') === 'etapa-1' ? DEALS.slice(0, 20) : [];
    r.fulfill({ json: { items, nextCursor: null } });
  });
  await page.route('**/v1/loss-reasons', (r) => r.fulfill({ json: [] }));
  await page.route('**/v1/saved-filters', (r) => r.fulfill({ json: [] }));
});

for (const [donde, ancho, alto] of [['escritorio', 1400, 900], ['celular', 390, 780]] as const)
test(`en ${donde}, la página no scrollea: scrollea cada columna por dentro`, async ({ page }) => {
  await page.setViewportSize({ width: ancho, height: alto });
  await page.goto('/oportunidades');
  const columna = page.getByRole('region', { name: 'Etapa Nuevo' });
  await expect(columna).toBeVisible();
  await expect(columna.getByText('Oportunidad de prueba número 1', { exact: true })).toBeVisible();

  const medido = await page.evaluate(() => document.documentElement.scrollHeight);
  expect(medido, `la página mide ${medido} px en una ventana de ${alto}`).toBeLessThanOrEqual(alto);

  // Y la columna entera entra en la ventana: si su borde de abajo queda
  // afuera, las últimas tarjetas son inalcanzables aunque la página no
  // scrollee. En celular es lo que pasaba.
  const caja = (await columna.boundingBox())!;
  expect(Math.round(caja.y + caja.height), 'la columna termina fuera de la ventana')
    .toBeLessThanOrEqual(alto);

  // El cuerpo de la columna SÍ scrollea: si no, las veinte tarjetas no se
  // pueden alcanzar y el alto acotado sería una jaula.
  //
  // Se MUEVE el scroll y se mira si quedó movido. Comparar `scrollHeight` con
  // `clientHeight` no sirve: `scrollHeight` mide el contenido tenga o no
  // `overflow`, así que la comparación da verdadero también cuando las
  // tarjetas se desbordan sin poder alcanzarse —que es el defecto—. Lo
  // comprobé sacando el `overflow-y-auto`: la prueba seguía verde.
  const movido = await columna.evaluate((sec) => {
    const d = sec.lastElementChild as HTMLElement;
    d.scrollTop = d.scrollHeight;
    return d.scrollTop;
  });
  expect(movido, 'el cuerpo de la columna no se puede scrollear').toBeGreaterThan(0);
});

test('la cabecera de la etapa no se va al bajar por las tarjetas', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/oportunidades');
  const columna = page.getByRole('region', { name: 'Etapa Nuevo' });
  const titulo = columna.getByRole('heading', { name: 'Nuevo' });
  const antes = (await titulo.boundingBox())!.y;
  // Se scrollea la sección Y todo lo que tenga adentro: si el `overflow`
  // estuviera puesto en la sección en vez de en el cuerpo, scrollear solo el
  // cuerpo no movería nada y la prueba pasaría con la cabecera yéndose.
  // Comprobado moviendo el `overflow` a la sección: pasaba verde.
  await columna.evaluate((sec) => {
    for (const el of [sec, ...sec.querySelectorAll('*')]) (el as HTMLElement).scrollTop = 9_999;
  });
  const despues = (await titulo.boundingBox())!.y;
  expect(despues, 'la cabecera se movió al scrollear la columna').toBeCloseTo(antes, 0);
});

test('la cabecera dice el dinero de la ETAPA, no el de lo cargado', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/oportunidades');
  const columna = page.getByRole('region', { name: 'Etapa Nuevo' });
  // 137 y $20.550.000 son los de la etapa; lo cargado son 20 tarjetas de
  // $150.000, o sea $3.000.000. Si apareciera ese número, estaría sumando lo
  // que tiene a mano y afirmándolo como total de la etapa.
  await expect(columna.getByText('137')).toBeVisible();
  await expect(columna.getByText(/20\.550\.000/)).toBeVisible();
  await expect(columna.getByText(/3\.000\.000/)).toHaveCount(0);
  await expect(columna.getByText('20', { exact: true })).toHaveCount(0);
});

test('el ancho es el de la pantalla, no el del contenedor de formularios', async ({ page }) => {
  // 1.920 y no 1.400: a 1.400, con la barra lateral puesta, quedan ~1.144
  // disponibles y el contenedor mide 1.120, así que la diferencia es de 24 px
  // y la medición no distingue nada. El contenedor es un TOPE: su costo
  // aparece cuando la pantalla sobra, y ahí son 500 px tirados.
  await page.setViewportSize({ width: 1920, height: 900 });
  await page.goto('/oportunidades');
  const tablero = page.getByRole('region', { name: 'Etapa Nuevo' }).locator('..');
  const caja = (await tablero.boundingBox())!;
  expect(caja.width, `el tablero mide ${Math.round(caja.width)} px en 1.920`).toBeGreaterThan(1_400);
});

test('la barra lateral sigue abierta: acá se navega, no te encerrás', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/oportunidades');
  // Lo que distingue el tablero de la bandeja: `sinMargen` daba las dos cosas
  // —ancho completo y barra plegada— y por eso hubo que separarlas.
  //
  // Se mira `data-state` del contenedor y no si el link «Bandeja» se ve: con
  // la barra plegada los links siguen en el DOM y visibles como iconos, así
  // que esa versión de la prueba pasaba con la barra cerrada.
  await expect(page.locator('div[data-side="left"][data-state]').first())
    .toHaveAttribute('data-state', 'expanded');
});
