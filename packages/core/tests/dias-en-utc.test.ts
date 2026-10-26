import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { diasEnUtc } from '../src/dias-en-utc';

/**
 * El trinquete de #1076: cada `toISOString().slice(0, 10)` del código de
 * producción dice si es una CLAVE o algo MOSTRADO.
 *
 * No prohíbe el patrón, y eso es a propósito. Es la forma canónica de armar
 * una clave de día en UTC y el repo la necesita —el contador de la cuota, el
 * índice de los tipos de cambio, el sufijo de un archivo bajado—. Prohibirlo
 * obligaría a inventar una excepción por cada uso legítimo, y una regla que la
 * mayoría incumple se termina incumpliendo (#784 lo midió con las consultas
 * entre módulos).
 *
 * Lo que sí es un defecto es usarlo para una fecha que una PERSONA lee: UTC no
 * es la zona de nadie, y en Chile adelanta un día cada noche a partir de las
 * 21:00. Apareció tres veces con esta forma exacta sin que nadie lo viera de
 * conjunto: #1072 (la portada fechaba el último mensaje al día siguiente),
 * #1074 (el panel de reportes pedía una ventana corrida, y los NÚMEROS salían
 * de otros días) y #1076 (dos pantallas no coincidían en qué día se borra el
 * historial, y el LEEME de la exportación prometía enlaces un día de más).
 *
 * Así que la guarda obliga a DECLARAR. Y a declarar con la cuenta: si un
 * archivo declarado suma una aparición nueva, la marca sube y hay que mirarla.
 */

// La suite corre con el cwd del paquete, así que las raíces se resuelven
// desde el archivo, igual que el resto de las guardas de core.
const RAIZ = join(__dirname, '..', '..', '..');
const RAICES = [join(RAIZ, 'apps'), join(RAIZ, 'packages'), join(RAIZ, 'scripts')];
const MOTIVOS = join(RAIZ, 'docs', 'dias-en-utc-motivos.json');
const corto = (ruta: string) => ruta.slice(RAIZ.length + 1);

interface Entrada {
  veces: number;
  tipo: string;
  motivo: string;
  evidencia: string;
}

function declarados(): Record<string, Entrada> {
  return (JSON.parse(readFileSync(MOTIVOS, 'utf8')) as { entradas: Record<string, Entrada> }).entradas;
}

describe('días en UTC, declarados o arreglados (#1076)', () => {
  it('el escáner encuentra algo (si esto falla, se rompió el escáner)', () => {
    expect(diasEnUtc(RAICES).length).toBeGreaterThan(0);
  });

  it('no aparece ningún sitio nuevo sin declarar si es clave o si se muestra', () => {
    const esperados = declarados();
    const nuevos = diasEnUtc(RAICES)
      .filter((d) => !esperados[corto(d.archivo)])
      .map((d) => `${corto(d.archivo)} (${d.veces})`);
    expect(
      nuevos,
      'Un `toISOString().slice(0, 10)` nuevo. Si es una CLAVE (contador, índice,\n' +
        'nombre de archivo), declaralo en docs/dias-en-utc-motivos.json con su\n' +
        'motivo. Si una PERSONA va a leer esa fecha, no va en UTC: usa\n' +
        '`diaEn(await zonaDelTenant(c, tenantId), instante)`.\n  ',
    ).toEqual([]);
  });

  it('y si un sitio se arregló, la marca BAJA', () => {
    const encontrados = new Map(diasEnUtc(RAICES).map((d) => [corto(d.archivo), d.veces]));
    const sobran = Object.keys(declarados()).filter((a) => !encontrados.has(a));
    expect(
      sobran,
      'Estos ya no tienen el patrón: saca su entrada de docs/dias-en-utc-motivos.json.\n' +
        'Sin esto el trinquete se afloja solo, y una deuda que no se ve bajar nunca baja:\n  ',
    ).toEqual([]);
  });

  it('la cuenta por archivo calza: una aparición nueva en un archivo declarado se ve', () => {
    const esperados = declarados();
    const descuadres = diasEnUtc(RAICES)
      .filter((d) => esperados[corto(d.archivo)] && esperados[corto(d.archivo)].veces !== d.veces)
      .map((d) => `${corto(d.archivo)}: ${d.veces} (declaradas ${esperados[corto(d.archivo)].veces})`);
    expect(
      descuadres,
      'Cambió la cantidad en un archivo ya declarado. Si la nueva es otra clave,\n' +
        'actualiza `veces` y amplía el motivo; si alguien va a LEER esa fecha, no va\n' +
        'en UTC.\n  ',
    ).toEqual([]);
  });

  it('cada motivo explica de verdad, y nombra su evidencia', () => {
    // Un motivo de tres palabras es una excepción muda con adorno, igual que
    // en el trinquete de estados vacíos.
    const mudos = Object.entries(declarados())
      .filter(([, e]) => e.motivo.trim().length < 80 || !e.evidencia?.trim() || !e.tipo?.trim())
      .map(([a]) => a);
    expect(mudos, 'Escribe el motivo de verdad, con su tipo y su evidencia').toEqual([]);
  });

  it('se cuenta con la fuente limpia: un comentario que nombre el patrón no cuenta', () => {
    // Lo que #569 pide, y acá importa doble: este archivo y el escáner
    // NOMBRAN el patrón en sus comentarios. Una guarda que se cuenta a sí
    // misma enseña a apagarla.
    const propios = diasEnUtc(RAICES).map((d) => corto(d.archivo));
    expect(propios).not.toContain('packages/core/src/dias-en-utc.ts');
    expect(propios).not.toContain('packages/core/tests/dias-en-utc.test.ts');
  });
});
