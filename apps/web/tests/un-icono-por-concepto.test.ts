import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fuenteLimpia } from '@iaxti/core/testing';

/**
 * Un icono por concepto (#1324, criterio de aceptación 1).
 *
 * «Tu asistente» e «Inteligencia» compartieron el dibujo del robot durante
 * meses sin que nada lo notara: dos destinos, dos grupos, un mismo icono. Eso
 * no se descubre mirando una captura —se aprende a no verlo— y se cuela solo
 * cada vez que un módulo nuevo trae su `nav`, así que acá hay una guarda y no
 * una lista de revisión.
 *
 * ## Fuente y no comportamiento, y por qué
 *
 * El mapa de iconos NO se arma en runtime: `ICONOS` y `ICONO_SECCION` son
 * tablas estáticas de `app-shell.tsx`, y la regla de qué entrada visible usa
 * cuál es una función determinista de dos archivos que ya se leen solos —
 * los manifiestos y el propio shell. Montar el componente con jsdom para
 * contar `<svg>` pediría sesión, catálogo y navegador para al final leer lo
 * mismo que está escrito en la fuente; y una prueba de comportamiento que
 * solo puede contestar «¿está escrito?» es la frágil de más (#564). Por eso
 * esta es una guarda de fuente, con `fuenteLimpia` (#569) para que el
 * comentario que la explica no sea el que la haga pasar.
 */

const RAIZ = join(__dirname, '..', '..', '..');
const MODULOS = join(RAIZ, 'packages', 'modules');
const SHELL = join(__dirname, '..', 'components', 'app-shell.tsx');

const SHELL_LIMPIO = fuenteLimpia(readFileSync(SHELL, 'utf8'));

interface Destino {
  modulo: string;
  label: string;
  path: string;
  grupo: string | null;
  seccion: string | null;
}

function destinos(): Destino[] {
  const salida: Destino[] = [];
  for (const modulo of readdirSync(MODULOS)) {
    const yaml = join(MODULOS, modulo, 'module.yaml');
    if (!existsSync(yaml)) continue;
    const texto = readFileSync(yaml, 'utf8');
    const bloque = /^nav:\s*\n((?:\s+.*\n)+?)(?=^\S|$)/m.exec(texto);
    if (!bloque) continue;
    for (const linea of bloque[1].split('\n')) {
      // Las entradas comentadas no están en el menú: no cuentan como visibles.
      if (linea.trim().startsWith('#') || !linea.includes('label:')) continue;
      salida.push({
        modulo,
        label: /label:\s*([^,}]+)/.exec(linea)?.[1].trim() ?? '?',
        path: /path:\s*([^,}]+)/.exec(linea)?.[1].trim() ?? '?',
        grupo: /grupo:\s*([^,}]+)/.exec(linea)?.[1].trim() ?? null,
        seccion: /seccion:\s*([^,}]+)/.exec(linea)?.[1].trim() ?? null,
      });
    }
  }
  return salida;
}

/** Los grupos que el shell muestra por sección, leídos de su constante. */
function gruposPorSeccion(): string[] {
  const m = /const POR_SECCION = new Set\(\[([^\]]+)\]\)/.exec(SHELL_LIMPIO);
  if (!m) throw new Error('no encontré la constante POR_SECCION en app-shell.tsx');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

/** Un mapa literal `Clave: Identificador` del shell, leído línea por línea. */
function mapaLiteral(nombre: string): Map<string, string> {
  const m = new RegExp(`const ${nombre}[^=]*= \\{([\\s\\S]*?)\\n\\};`).exec(SHELL_LIMPIO);
  if (!m) throw new Error(`no encontré la constante ${nombre} en app-shell.tsx`);
  const mapa = new Map<string, string>();
  for (const linea of m[1].split('\n')) {
    const e = /^\s*(?:'([^']+)'|([\w À-ÿ-]+)):\s*(\w+)\s*,?\s*$/.exec(linea);
    if (!e) continue;
    const clave = (e[1] ?? e[2] ?? '').trim();
    if (clave) mapa.set(clave, e[3]);
  }
  return mapa;
}

/** El icono de «Cerrar sesión», que no sale de ningún manifiesto. */
function iconoDeCerrarSesion(): string {
  const m = /function CerrarSesion\(\)[\s\S]*?<(\w+)\s*\/>/.exec(SHELL_LIMPIO);
  if (!m) throw new Error('no encontré el icono de CerrarSesion en app-shell.tsx');
  return m[1];
}

describe('un icono por concepto', () => {
  /**
   * Las entradas que la barra puede llegar a dibujar, con el icono con que las
   * dibujaría: una por sección en los grupos de POR_SECCION, una por pantalla
   * en el resto, y «Cerrar sesión» del pie. La visibilidad por permiso o por
   * plan no se modela a propósito: dos conceptos con el mismo dibujo están mal
   * aunque solo un rol alcance a ver a los dos.
   */
  const entradas = new Map<string, { icono: string; detalle: string }>();
  const porSeccion = new Set(gruposPorSeccion());
  const iconos = mapaLiteral('ICONOS');
  const iconosDeSeccion = mapaLiteral('ICONO_SECCION');

  for (const d of destinos()) {
    if (d.grupo && porSeccion.has(d.grupo)) {
      // El fallback de `porSeccion()`: sin sección declarada, a Cuenta.
      const seccion = d.seccion ?? 'Cuenta';
      entradas.set(`sección ${seccion} (${d.grupo})`, {
        icono: iconosDeSeccion.get(seccion) ?? 'Settings',
        detalle: `sección «${seccion}» del grupo «${d.grupo}»`,
      });
    } else {
      entradas.set(d.path, {
        icono: iconos.get(d.path) ?? 'Settings',
        detalle: `«${d.label}» (${d.modulo})`,
      });
    }
  }
  entradas.set('cerrar-sesion', { icono: iconoDeCerrarSesion(), detalle: '«Cerrar sesión» (pie de la barra)' });

  it('hay entradas que mirar', () => {
    // Si el manifiesto de un módulo se reestructura y esta guarda deja de
    // leerlo, que se ponga roja por quedarse corta y no verde por vacía.
    expect(entradas.size).toBeGreaterThanOrEqual(10);
    expect(iconos.size).toBeGreaterThanOrEqual(10);
  });

  it('ninguna entrada visible comparte icono con otra', () => {
    const porIcono = new Map<string, string[]>();
    for (const [clave, { icono }] of entradas) {
      porIcono.set(icono, [...(porIcono.get(icono) ?? []), clave]);
    }
    const repetidos = [...porIcono.entries()].filter(([, claves]) => claves.length > 1);
    expect(
      repetidos,
      'Dos entradas de la barra comparten icono (#1324): si dos conceptos llevan el mismo ' +
        'dibujo, uno de los dos está mal nombrado o sobra. Dale un icono propio en ICONOS o ' +
        'ICONO_SECCION de app-shell.tsx — y si el concepto es el mismo, la entrada que sobra ' +
        'es la que hay que sacar.\n' +
        repetidos
          .map(([icono, claves]) => `  ${icono}: ${claves.map((c) => entradas.get(c)!.detalle).join(' · ')}`)
          .join('\n'),
    ).toEqual([]);
  });
});