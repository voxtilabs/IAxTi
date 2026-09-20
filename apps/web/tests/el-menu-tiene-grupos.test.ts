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
      salida.push({ modulo, label, grupo });
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
