import { describe, expect, it } from 'vitest';
import { coalescenciasEnTexto, entornoConCoalescencia } from '../src/entorno-con-coalescencia';
import { join } from 'node:path';

const RAIZ = join(__dirname, '..', '..', '..');

/**
 * La guarda de #575: ninguna lectura del entorno se escribe con `??` y un
 * valor por defecto, porque `??` no atrapa la cadena vacía.
 *
 * Esta lista está VACÍA a propósito, y eso es la mitad del valor. Las catorce
 * que había se arreglaron en el mismo PR: dejar un trinquete con números
 * («de 14 no pasar») habría conservado el defecto y la costumbre. Si mañana
 * aparece una excepción de verdad, se agrega acá con su motivo escrito; lo
 * que no se puede es agregarla en silencio.
 */
const PERMITIDAS: string[] = [];

describe('lecturas del entorno con ?? (#575)', () => {
  it('ninguna variable de entorno cae a su defecto con ??', () => {
    const hallazgos = entornoConCoalescencia([
      join(RAIZ, 'apps'),
      join(RAIZ, 'packages'),
    ]).filter((h) => !PERMITIDAS.includes(`${h.archivo.slice(RAIZ.length + 1)}:${h.variable}`));

    expect(
      hallazgos.map((h) => `${h.archivo.slice(RAIZ.length + 1)}:${h.linea} → ${h.variable}`),
    ).toEqual([]);
  });

  it('acepta las formas que sí normalizan la cadena vacía', () => {
    // Un archivo de verdad del repo que usa la forma aceptada: si alguien la
    // «arregla» a `??` o si la guarda empieza a cazarla, esto se cae.
    const aceptadas = entornoConCoalescencia([join(RAIZ, 'apps', 'web', 'lib')]);
    expect(aceptadas).toEqual([]);
  });

  /**
   * Las de abajo son contra la vacuidad (#823).
   *
   * Las dos de arriba son `toEqual([])`, y una lista vacía la satisface
   * también un escáner ciego. No es un riesgo teórico: este escáner depende de
   * `fuenteLimpia`, y ya pasó una vez que `fuenteLimpia` devolviera texto en
   * blanco y tres pruebas de #690 se pusieran verdes sin comprobar nada — lo
   * que las delató fue una aserción POSITIVA. Todos los hermanos de este
   * directorio tienen la suya; a ésta le faltaba.
   */
  it('caza la forma que vino a prohibir, con su variable y su línea', () => {
    const texto = [
      'const a = 1;',
      "const url = process.env.PUBLIC_API_URL ?? 'http://localhost:3001';",
    ].join('\n');
    expect(coalescenciasEnTexto(texto)).toEqual([{ linea: 2, variable: 'PUBLIC_API_URL' }]);
  });

  it('una CADENA de ?? se reporta por la primera, que es la que gana en blanco', () => {
    const texto = "const u = process.env.A ?? process.env.B ?? 'x';";
    // Una sola vez y por `A`, no dos: el `matchAll` consume
    // `process.env.A ?? process.env.B` como una coincidencia. Y alcanza —lo
    // que hay que arreglar es la línea, y el defecto está en `A`: si viene en
    // blanco gana `A`, y `B` y el defecto no se miran nunca.
    //
    // Escribí esta aserción esperando `['A', 'B']` y el escáner dijo `['A']`.
    // Mirándolo, el escáner tiene razón; la expectativa era mía. Queda escrito
    // porque el próximo que lea la expresión se va a hacer la misma pregunta.
    expect(coalescenciasEnTexto(texto).map((h) => h.variable)).toEqual(['A']);
  });

  it('NO caza las cuatro formas inocuas, ni con `.trim()` pegado', () => {
    const texto = [
      "const a = process.env.A ?? '';",
      'const b = process.env.B ?? "";',
      'const c = process.env.C ?? null;',
      'const d = process.env.D ?? undefined;',
      "const e = (process.env.E ?? '').trim();",
    ].join('\n');
    expect(coalescenciasEnTexto(texto)).toEqual([]);
  });

  it('y `?? nullish` no se confunde con `?? null`', () => {
    // Sin el `(?![A-Za-z0-9_$])` del filtro, éste pasaría por inocuo.
    expect(coalescenciasEnTexto('const x = process.env.X ?? nullish;')).toEqual([
      { linea: 1, variable: 'X' },
    ]);
  });

  /**
   * El punto ciego de #985, con su caso.
   *
   * Un archivo que desestructura `process.env` primero quedaba invisible para
   * la expresión, que pide el `process.env.` escrito. No es teórico: así estaba
   * `Number(SMTP_PORT ?? 587)` en los avisos, y con la variable pasada vacía
   * por el compose el transporte se armaba contra el puerto 0.
   */
  it('ve el `??` aunque el nombre venga de desestructurar process.env', () => {
    const fuente = [
      'const { SMTP_HOST, SMTP_PORT } = process.env;',
      'const t = createTransport({ host: SMTP_HOST, port: Number(SMTP_PORT ?? 587) });',
    ].join('\n');
    expect(coalescenciasEnTexto(fuente)).toEqual([{ linea: 2, variable: 'SMTP_PORT' }]);
  });

  it('no confunde una propiedad ni una variable local con la del entorno', () => {
    const fuente = [
      'const { SMTP_PORT } = process.env;',
      // `algo.SMTP_PORT` es una propiedad, no la lectura del entorno.
      'const a = algo.SMTP_PORT ?? 587;',
      // Y un nombre en minúsculas no es una variable de entorno.
      'const { puerto } = process.env;',
      'const b = puerto ?? 587;',
    ].join('\n');
    expect(coalescenciasEnTexto(fuente)).toEqual([]);
  });

  it('el defecto inocuo sigue siendo inocuo cuando el nombre vino desestructurado', () => {
    const fuente = [
      'const { SMTP_FROM } = process.env;',
      "const f = (SMTP_FROM ?? '').trim();",
    ].join('\n');
    expect(coalescenciasEnTexto(fuente)).toEqual([]);
  });
});
