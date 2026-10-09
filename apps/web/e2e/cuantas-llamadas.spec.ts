import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const auth = JSON.parse(readFileSync(join(__dirname, '.auth.json'), 'utf8'));

/**
 * Cuántas llamadas cuesta abrir la bandeja (#711).
 *
 * ## Por qué esto es una prueba y no una medición en un comentario
 *
 * #711 midió el problema de fondo: la base está lejos del VPS y **cada consulta
 * cuesta 64 ms de viaje**, haga lo que haga (local es ~1 ms). Con eso, el número
 * de llamadas de una pantalla deja de ser un detalle: 21 llamadas que el
 * navegador además serializa de a seis por host son segundos de espera que no
 * tienen ninguna consulta lenta detrás.
 *
 * El criterio 4 del issue pide que la medición se repita y **quede escrita**:
 * «sin eso esto es una opinión». Escrita en un comentario envejece en una
 * semana; escrita como presupuesto se defiende sola. Si alguien agrega una
 * llamada, esto se pone rojo y le cuenta cuánto cuesta — no para prohibirla,
 * sino para que la decisión sea a la vista. Subir el número es parte de agregar
 * la llamada, con su motivo en el mismo PR.
 *
 * ## Lo medido (09-10, local, 3 corridas idénticas)
 *
 * | Momento | Llamadas distintas a `/v1` |
 * |---|---|
 * | Abrir `/bandeja` | **7** |
 * | Con una conversación abierta | **21** |
 *
 * Y ninguna repetida: son 21 endpoints distintos. O sea que lo que queda por
 * ganar no es quitar duplicados —no hay— sino **agrupar**: un arranque para el
 * shell y otro para la conversación. Eso es un cambio de forma de la API, con
 * sus rutas, su OpenAPI y sus consumidores, y va en su propio issue (#761).
 *
 * ## Qué se cuenta
 *
 * Endpoints DISTINTOS, no peticiones crudas: el sondeo de la sugerencia y de
 * las notificaciones repite las suyas cada tanto, y contar eso haría que el
 * número dependa de cuánto tardó la máquina en llegar al final de la prueba.
 * Lo que este presupuesto cuida es la FORMA de la pantalla —de cuántas puertas
 * distintas depende— que es lo que un arranque agrupado puede cambiar.
 */
const PRESUPUESTO_BANDEJA = 7;
const PRESUPUESTO_CON_CONVERSACION = 21;

test('abrir la bandeja y una conversación no cuesta más llamadas que las medidas (#711)', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.addInitScript((auth) => {
    localStorage.setItem('iaxti-tenant', auth.tenantId);
    localStorage.setItem('sb-127-auth-token', JSON.stringify({
      access_token: auth.accessToken, token_type: 'bearer', expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'e2e',
      user: { id: auth.userId, aud: 'authenticated', email: 'perf@e2e.cl' },
    }));
  }, auth);

  // Los ids se normalizan: lo que importa es de cuántas PUERTAS depende la
  // pantalla, no cuántos contactos distintos miró.
  const puertas = new Set<string>();
  page.on('request', (r) => {
    const { pathname } = new URL(r.url());
    if (!pathname.startsWith('/v1')) return;
    puertas.add(`${r.method()} ${pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ':id')}`);
  });

  await page.goto('/bandeja');
  await expect(page.getByRole('heading', { name: 'Bandeja', exact: true })).toBeVisible();
  const lista = page.getByRole('region', { name: 'Conversaciones', exact: true });
  const conversaciones = lista.locator('ul > li').getByRole('button');
  await expect(conversaciones.first()).toBeVisible();

  expect(
    [...puertas].sort(),
    `Abrir la bandeja cuesta ${puertas.size} llamadas y el presupuesto es ${PRESUPUESTO_BANDEJA} (#711). ` +
      'Con la base a 64 ms de viaje, cada una se paga. Si la llamada nueva hace falta, sube el ' +
      'número acá y escribe por qué en el PR.',
  ).toHaveLength(PRESUPUESTO_BANDEJA);

  await conversaciones.first().click();
  await expect(page.getByRole('region', { name: 'Conversación', exact: true })).toBeVisible();
  // La ficha y las secuencias llegan después del chat: sin esta espera, el
  // número mediría cuánto alcanzó a pedir la página antes de que la prueba
  // siguiera, que es otra forma de medir la carga de la máquina.
  await expect(page.getByText('Notas del equipo')).toBeVisible();
  await expect
    .poll(() => puertas.size, { timeout: 10_000, intervals: [250] })
    .toBeGreaterThanOrEqual(PRESUPUESTO_CON_CONVERSACION);

  expect(
    [...puertas].sort(),
    `Abrir una conversación cuesta ${puertas.size} llamadas distintas y el presupuesto es ` +
      `${PRESUPUESTO_CON_CONVERSACION} (#711). Agruparlas es #761; agregar una más es una decisión ` +
      'que se escribe, no un número que sube solo.',
  ).toHaveLength(PRESUPUESTO_CON_CONVERSACION);
});
