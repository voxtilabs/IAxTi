import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Cada destino del menú declara a qué grupo va.
 *
 * La barra lateral (#295) reparte 23 destinos en tres listas. El `grupo` lo
 * declara cada `module.yaml`, igual que el `label` y el `path`, y no una
 * tabla en el frontend: una lista paralela allá se desincroniza, y el
 * síntoma sería que el destino nuevo aparece suelto al final sin que nadie
 * lo note — que es exactamente el tipo de cosa que en este repo se
 * descubre tres meses después.
 *
 * El shell tiene una salida por si acaso (sin `grupo` cae en
 * Configuración), justamente para que un manifiesto a medio migrar no deje
 * a nadie sin menú. Este test existe para que esa salida no se convierta en
 * el camino normal.
 */
const RAIZ = join(__dirname, '..', '..', '..');
const MODULOS = join(RAIZ, 'packages', 'modules');
const SHELL = join(__dirname, '..', 'components', 'app-shell.tsx');

/** Los grupos que el shell sabe ordenar, leídos de su propia constante. */
function gruposDelShell(): string[] {
  const m = /const ORDEN = \[([^\]]+)\]/.exec(readFileSync(SHELL, 'utf8'));
  if (!m) throw new Error('no encontré la constante ORDEN en app-shell.tsx');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

interface Destino {
  modulo: string;
  label: string;
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
      if (!linea.includes('label:')) continue;
      const label = /label:\s*([^,}]+)/.exec(linea)?.[1].trim() ?? '?';
      const grupo = /grupo:\s*([^,}]+)/.exec(linea)?.[1].trim() ?? null;
      const seccion = /seccion:\s*([^,}]+)/.exec(linea)?.[1].trim() ?? null;
      salida.push({ modulo, label, grupo, seccion });
    }
  }
  return salida;
}

describe('el menú tiene grupos', () => {
  const todos = destinos();
  const conocidos = gruposDelShell();

  it('hay destinos que mirar', () => {
    expect(todos.length).toBeGreaterThanOrEqual(15);
    expect(conocidos.length).toBeGreaterThanOrEqual(2);
  });

  it('cada destino declara su grupo', () => {
    const sin = todos.filter((d) => !d.grupo);
    expect(
      sin,
      'Estos destinos no dicen a qué grupo van y caerían en Configuración:\n' +
        sin.map((d) => `  ${d.label} (${d.modulo})`).join('\n'),
    ).toEqual([]);
  });

  it('todos los grupos usados son de los que el shell ordena', () => {
    // Un grupo desconocido se dibuja igual, al final. No es un error: es
    // que nadie decidió dónde va.
    const raros = [...new Set(todos.map((d) => d.grupo!))].filter((g) => !conocidos.includes(g));
    expect(
      raros,
      `Grupos que el shell no sabe dónde poner y manda al final: ${raros.join(', ')}.\n` +
        `Agrégalos a ORDEN en app-shell.tsx, o usa uno de: ${conocidos.join(', ')}.`,
    ).toEqual([]);
  });

  it('ningún grupo se queda vacío', () => {
    const usados = new Set(todos.map((d) => d.grupo));
    const vacios = conocidos.filter((g) => !usados.has(g));
    expect(vacios, `grupos anunciados y sin un solo destino: ${vacios.join(', ')}`).toEqual([]);
  });
});

/**
 * Y lo mismo para las secciones de ajustes (#387).
 *
 * Dieciséis destinos sueltos en el menú eran dieciséis decisiones para
 * alguien que solo quería cambiar una cosa. Ahora van en cinco secciones, y
 * la pertenencia la declara cada `module.yaml` por el mismo motivo que el
 * `grupo`: una tabla paralela en el frontend se desincroniza al primer
 * módulo nuevo, y el síntoma es una pantalla suelta al final que nadie
 * nota.
 */
describe('los ajustes declaran su sección', () => {
  const ajustes = destinos().filter((d) => d.grupo === 'Configuración');
  const conocidas = (() => {
    const m = /const ORDEN_SECCIONES = \[([^\]]+)\]/.exec(readFileSync(SHELL, 'utf8'));
    if (!m) throw new Error('no encontré ORDEN_SECCIONES en app-shell.tsx');
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  })();

  it('hay ajustes que mirar', () => {
    expect(ajustes.length).toBeGreaterThanOrEqual(10);
    expect(conocidas.length).toBeGreaterThanOrEqual(3);
  });

  it('cada pantalla de ajustes dice a qué sección va', () => {
    const sin = ajustes.filter((d) => !d.seccion);
    expect(
      sin,
      'Estas pantallas de ajustes no declaran sección y caerían en Cuenta:\n' +
        sin.map((d) => `  ${d.label} (${d.modulo})`).join('\n'),
    ).toEqual([]);
  });

  it('las secciones usadas son de las que el shell ordena', () => {
    const raras = [...new Set(ajustes.map((d) => d.seccion!))].filter((s) => !conocidas.includes(s));
    expect(
      raras,
      `Secciones que el shell no sabe dónde poner: ${raras.join(', ')}.\n` +
        `Agrégalas a ORDEN_SECCIONES, o usa una de: ${conocidas.join(', ')}.`,
    ).toEqual([]);
  });

  it('ninguna sección se anuncia vacía, y ninguna queda con una sola', () => {
    const usadas = new Map<string, number>();
    for (const d of ajustes) usadas.set(d.seccion!, (usadas.get(d.seccion!) ?? 0) + 1);
    const vacias = conocidas.filter((s) => !usadas.has(s));
    expect(vacias, `secciones anunciadas y sin una sola pantalla: ${vacias.join(', ')}`).toEqual([]);
    // Una sección de una pantalla es una pestaña sola: ruido con forma de
    // navegación. La pantalla lo evita no dibujándolas, pero si pasa es que
    // la agrupación quedó mal.
    const solitarias = [...usadas].filter(([, n]) => n < 2).map(([s]) => s);
    expect(solitarias, `secciones con una sola pantalla: ${solitarias.join(', ')}`).toEqual([]);
  });
});
