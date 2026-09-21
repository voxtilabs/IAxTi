import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Todas las pantallas empiezan igual (#398).
 *
 * Antes cada una se inventaba su encabezado. Medido: TRES formas distintas
 * de escribir el mismo título —`font-display text-titulo text-ink`,
 * `text-titulo font-extrabold text-ink`, `mt-1 font-display text-titulo
 * font-bold text-ink`— y una pantalla abriendo con `<h2>`.
 *
 * Y la acción principal quedaba a miles de caracteres del título en el
 * archivo: enterrada abajo, no donde el ojo va primero.
 *
 * Eso es lo que se lee como andamio, y no es el color: lo que hace que un
 * producto se vea terminado es que todas las pantallas empiecen igual.
 */
const COMPONENTES = join(__dirname, '..', 'components');

/** Lo que NO es una pantalla del producto, con su motivo. */
const EXCEPCIONES: Record<string, string> = {
  'puesta-en-marcha.tsx':
    'La portada lleva hero propio (Pulso Vivo, ADR-0021): cintillo, título y ' +
    'la marca jelly al lado. Es la única pantalla que se ve antes de entrar a ' +
    'trabajar y la única donde la marca aparece en grande; el encabezado ' +
    'uniforme le quitaría justo eso.',
  'aceptar-invitacion.tsx':
    'Página pública, fuera del shell: tres estados excluyentes (aceptada, ' +
    'por aceptar, inválida) y ninguno es una pantalla del producto con su ' +
    'encabezado y su acción.',
};

function fuentes(dir: string, acc: string[] = []): string[] {
  for (const entrada of readdirSync(dir)) {
    const ruta = join(dir, entrada);
    if (statSync(ruta).isDirectory()) fuentes(ruta, acc);
    else if (entrada.endsWith('.tsx')) acc.push(ruta);
  }
  return acc;
}

describe('todas las pantallas empiezan igual', () => {
  const archivos = fuentes(COMPONENTES);

  it('hay pantallas que mirar', () => {
    expect(archivos.length).toBeGreaterThan(25);
  });

  it('ninguna se inventa su propio título', () => {
    const propios: string[] = [];
    for (const archivo of archivos) {
      const nombre = archivo.split('/').pop()!;
      if (nombre in EXCEPCIONES) continue;
      const n = (readFileSync(archivo, 'utf8').match(/<h1\b/g) ?? []).length;
      if (n > 0) propios.push(`${nombre}: ${n} <h1> a mano`);
    }
    expect(
      propios,
      'Pantallas con su propio <h1>:\n  ' +
        propios.join('\n  ') +
        '\nUsa EncabezadoDePagina. Tres formas de escribir el mismo título es ' +
        'exactamente lo que hacía ver el producto como un andamio.',
    ).toEqual([]);
  });

  it('el encabezado se usa de verdad, no solo existe', () => {
    // Un componente que nadie usa es peor que no tenerlo: da la sensación
    // de que el problema está resuelto.
    const usos = archivos.filter((a) => readFileSync(a, 'utf8').includes('<EncabezadoDePagina')).length;
    expect(usos).toBeGreaterThanOrEqual(15);
  });

  it('la lista de excepciones no junta polvo', () => {
    const nombres = new Set(archivos.map((a) => a.split('/').pop()!));
    const sobrantes = Object.keys(EXCEPCIONES).filter((e) => !nombres.has(e));
    expect(sobrantes, `excepciones de archivos que ya no existen: ${sobrantes.join(', ')}`).toEqual([]);
  });

  it('cada excepción trae su motivo escrito', () => {
    for (const [nombre, motivo] of Object.entries(EXCEPCIONES)) {
      expect(motivo.length, `el motivo de ${nombre} es muy corto`).toBeGreaterThan(50);
    }
  });
});
