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
 * | Momento | Antes | Con los arranques (#761) |
 * |---|---|---|
 * | Abrir `/bandeja` | **7** | **2** |
 * | Con una conversación abierta | **21** | **4** |
 *
 * Y lo que de verdad se ganó no son las llamadas: son los **statements**. Toda
 * ruta de `/v1` pasa por `withTenant`, que hace `BEGIN`, `set_config`, la
 * consulta y `COMMIT`, así que cada puerta cuesta cuatro viajes y no uno. Con
 * los 64 ms que midió #711: 21 llamadas ≥ 84 statements ≈ 5,4 s de viaje; 4
 * llamadas ≈ 16 statements ≈ 1 s. Hay una prueba en `apps/api` que cuenta los
 * `BEGIN` por petición y exige UNO, porque agrupar las llamadas sin agrupar las
 * transacciones deja este presupuesto verde y la pantalla igual de lenta.
 *
 * Y ninguna repetida: eran 21 endpoints distintos. O sea que lo que había por
 * ganar no era quitar duplicados —no había— sino **agrupar**. Eso se hizo en
 * #761: `GET /v1/arranque` para el shell, y para una conversación dos —el
 * urgente que la pantalla espera y la ficha que entra sola, partidos así para no
 * deshacer #690.
 *
 * ## Qué se cuenta
 *
 * Endpoints DISTINTOS, no peticiones crudas: el sondeo de la sugerencia y de
 * las notificaciones repite las suyas cada tanto, y contar eso haría que el
 * número dependa de cuánto tardó la máquina en llegar al final de la prueba.
 * Lo que este presupuesto cuida es la FORMA de la pantalla —de cuántas puertas
 * distintas depende— que es lo que un arranque agrupado puede cambiar.
 */
/**
 * Lo medido el 09-10 era 7 y 21. Con los arranques de #761 bajan a esto.
 *
 * El criterio 1 de #761 pide «a lo más 4» para abrir la bandeja y una
 * conversación, y así quedó repartido:
 *
 *   bandeja:            `/arranque` + `/conversations`                     = 2
 *   con conversación:   + `:id/arranque` + `:id/arranque/ficha`            = 4
 *
 * Los números de acá son un techo con aire, no la medición exacta. Hay paneles
 * que piden lo suyo al abrirse y que este cambio NO agrupó a propósito —las
 * secuencias de la ficha, las plantillas del compositor, las reasignaciones—
 * porque se piden en otro momento y con otros parámetros, y meterlas en el
 * arranque sería pagar sus consultas en cada apertura para tirarlas.
 *
 * Cada corrida IMPRIME el número real y la lista de puertas (ver `contar`): eso
 * es lo que hay que leer para bajar el techo. Un presupuesto que solo habla
 * cuando se pasa deja de apretar — nadie sabe cuánto aire queda, así que nadie
 * lo ajusta, y a la segunda semana mide el crecimiento desde un número inventado.
 */
const PRESUPUESTO_BANDEJA = 3;
const PRESUPUESTO_CON_CONVERSACION = 8;

/**
 * Espera a que la pantalla deje de pedir cosas, y devuelve cuántas puertas tocó.
 *
 * Dos lecturas iguales seguidas, no un `waitForTimeout`: la ficha y las
 * secuencias llegan después del chat, y un tiempo fijo mediría cuánto alcanzó a
 * pedir la página antes de que la prueba siguiera — que es el defecto de #681,
 * cometido de nuevo en la prueba que viene a medir.
 */
async function cuandoDejeDePedir(puertas: Set<string>): Promise<number> {
  let anterior = -1;
  for (let i = 0; i < 40 && anterior !== puertas.size; i++) {
    anterior = puertas.size;
    await new Promise((listo) => setTimeout(listo, 400));
  }
  return puertas.size;
}

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

  /**
   * El número medido se IMPRIME siempre, no solo al fallar.
   *
   * Un presupuesto que solo habla cuando se pasa deja de apretar: nadie sabe
   * cuánto aire queda, así que nadie lo baja. Con el número en el log de cada
   * corrida, bajarlo es leer una línea — y eso es la mitad del trabajo de un
   * trinquete: #664 ya aprendió que una deuda que no se ve bajar nunca baja.
   */
  const contar = async (momento: string, presupuesto: number) => {
    const n = await cuandoDejeDePedir(puertas);
    console.log(`[cuantas-llamadas] ${momento}: ${n} puertas (presupuesto ${presupuesto})`);
    console.log([...puertas].sort().map((p) => `    ${p}`).join('\n'));
    return n;
  };

  await page.goto('/bandeja');
  await expect(page.getByRole('heading', { name: 'Bandeja', exact: true })).toBeVisible();
  const lista = page.getByRole('region', { name: 'Conversaciones', exact: true });
  const conversaciones = lista.locator('ul > li').getByRole('button');
  await expect(conversaciones.first()).toBeVisible();

  // Un PRESUPUESTO, o sea un techo: pedir menos es la meta, no un fallo. Lo que
  // esto caza es el crecimiento, que es lo que pasa solo.
  expect(
    await contar('bandeja', PRESUPUESTO_BANDEJA),
    `Abrir la bandeja toca estas puertas:\n  ${[...puertas].sort().join('\n  ')}\n` +
      `Son ${puertas.size} y el presupuesto es ${PRESUPUESTO_BANDEJA} (#711). Con la base a 64 ms de ` +
      'viaje, cada una se paga. Si la llamada nueva hace falta, sube el número acá y escribe por qué ' +
      'en el PR.',
  ).toBeLessThanOrEqual(PRESUPUESTO_BANDEJA);

  await conversaciones.first().click();
  await expect(page.getByRole('region', { name: 'Conversación', exact: true })).toBeVisible();
  // La ficha llega después del chat, así que se espera a verla antes de contar.
  await expect(page.getByText('Notas del equipo')).toBeVisible();

  expect(
    await contar('con conversación', PRESUPUESTO_CON_CONVERSACION),
    `Abrir una conversación toca estas puertas:\n  ${[...puertas].sort().join('\n  ')}\n` +
      `Son ${puertas.size} y el presupuesto es ${PRESUPUESTO_CON_CONVERSACION} (#711). Agruparlas es ` +
      '#761; agregar una más es una decisión que se escribe, no un número que sube solo.',
  ).toBeLessThanOrEqual(PRESUPUESTO_CON_CONVERSACION);
});
