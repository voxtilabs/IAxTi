import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fuenteLimpia } from '../src/testing';

/**
 * Nadie recalcula el ciclo de consumo por su cuenta (#1137).
 *
 * El producto lo calcula con `periodStart()`, que resuelve en `IAXTI_TZ`
 * —`America/Santiago` por defecto—. Dos pruebas lo armaban aparte: una con
 * `new Date().toISOString().slice(0, 7)` (UTC) y otra con
 * `date_trunc('month', now())` (el reloj del servidor de base).
 *
 * Entre las 00:00 y las 03:00 UTC del día 1 esas tres cuentas no dan el mismo
 * mes. La prueba escribía la fila de un mes y el código la buscaba en el
 * otro, así que devolvía cero. CI se puso rojo a las 00:41 UTC del 1 de
 * noviembre, con siete pruebas caídas a la vez.
 *
 * Lo que lo hace peor que un rojo común: falla **tres horas al mes**. Entre
 * borde y borde parece verde, así que no lo encuentra nadie mirando — lo
 * encontró el calendario.
 *
 * Y una prueba que recalcula lo que vigila, vigila su propia copia: si
 * `periodStart()` cambiara de criterio, las dos habrían seguido verdes contra
 * sí mismas.
 *
 * `.claude/rules/testing.md` ya lo decía —«una prueba no mide el reloj de la
 * máquina»—, escrito por tres pruebas de #587 que se caían después de las
 * 21:00 en Chile. Esta guarda es esa regla, aplicada.
 */
const RAIZ = join(__dirname, '..', '..', '..');

/** Las dos formas de armar un mes que NO son `periodStart()`. */
const COPIAS = [
  { patron: /toISOString\(\)\s*\.\s*slice\(0,\s*7\)/, que: 'el mes en UTC desde JavaScript' },
  { patron: /date_trunc\(\s*'month'\s*,\s*now\(\)/, que: "date_trunc('month', now()) de Postgres" },
];

function fuentes(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (['node_modules', 'dist', '.next', '.git', 'coverage'].includes(e)) continue;
    const ruta = join(dir, e);
    if (statSync(ruta).isDirectory()) fuentes(ruta, acc);
    else if (/\.tsx?$/.test(e)) acc.push(ruta);
  }
  return acc;
}

describe('el ciclo de consumo no se recalcula (#1137)', () => {
  it('nadie que toque `usage_meters` arma el mes por su cuenta', () => {
    /*
     * Pruebas Y código de producción, y lo segundo no es por completitud.
     *
     * La primera versión miraba solo pruebas, y mientras la escribía apareció
     * el caso de verdad: `apps/api/src/app.module.ts` leía el consumo de
     * TODOS los tenants con `um.period_start = date_trunc('month', now())`
     * mientras `incrementUsage` escribe con `periodStart()`. En el borde del
     * mes el JOIN no encontraba nada y el listado de la plataforma mostraba
     * cero para todos — y «cero» ahí no se lee como un error, se lee como que
     * nadie usó la API.
     *
     * O sea que la prueba que estaba roja no era una prueba frágil: estaba
     * señalando el defecto.
     */
    const culpables: string[] = [];
    const donde = [join(RAIZ, 'packages', 'modules'), join(RAIZ, 'apps', 'api', 'src')];
    for (const archivo of donde.flatMap((d) => fuentes(d))) {
      const fuente = fuenteLimpia(readFileSync(archivo, 'utf8'));
      /*
       * Solo `usage_meters`, que es la tabla con DOS relojes: la prueba
       * escribe la fila y el producto la busca con `periodStart()`.
       *
       * El primer filtro decía «o menciona periodStart», y marcó
       * `billing.test.ts` — donde `periodStart` es el NOMBRE DE UN PARÁMETRO
       * y no hay segundo reloj: esa prueba escribe `cycle_start` en la base y
       * lo lee de vuelta de la misma base, así que las dos puntas siempre
       * coinciden. Una guarda que marca lo correcto enseña a apagarla.
       */
      if (!fuente.includes('usage_meters')) continue;
      for (const { patron, que } of COPIAS) {
        if (patron.test(fuente)) {
          culpables.push(`${archivo.slice(RAIZ.length + 1)} usa ${que}`);
        }
      }
    }
    expect(culpables).toEqual([]);
  });

  it('`periodStart` sigue resolviendo en la zona del tenant, no en UTC', () => {
    // Si alguien la pasara a UTC, la guarda de arriba perdería sentido: todas
    // las copias volverían a coincidir y nadie notaría que el producto cambió
    // de criterio.
    const fuente = fuenteLimpia(
      readFileSync(join(RAIZ, 'packages', 'modules', 'organizations', 'application', 'usage.ts'), 'utf8'),
    );
    expect(fuente).toContain("textoDeEntorno('IAXTI_TZ'");
  });
});
