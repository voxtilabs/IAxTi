import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fuenteLimpia } from '@iaxti/core/testing';

/**
 * Todas las pantallas empiezan igual (#398), y se queda así (#1323).
 *
 * Antes cada una se inventaba su encabezado. Medido: TRES formas distintas
 * de escribir el mismo título —`font-display text-titulo text-ink`,
 * `text-titulo font-extrabold text-ink`, `mt-1 font-display text-titulo
 * font-bold text-ink`— y una pantalla abriendo con `<h2>`.
 *
 * #1323 cierra la vuelta: hay UNA envoltura de título (`EncabezadoDePagina`)
 * y la miga del topbar se fue. Dónde estás se lo dice el título de la
 * página, en el mismo lugar y al mismo tamaño siempre. Si una pantalla
 * vuelve a dibujar su propio `<h1>`, el producto vuelve a tener dos
 * gramáticas — y esa es la clase de cosa que solo se nota cuando ya hay
 * ocho pantallas haciéndolo distinto.
 *
 * La guarda mira la fuente LIMPIA (#569): los comentarios de este mismo
 * archivo mencionan `<h1` y no por eso se ponen rojos.
 */
const COMPONENTES = join(__dirname, '..', 'components');
const APP = join(__dirname, '..', 'app');

/** Lo que NO pasa por la envoltura, con su motivo. */
const EXCEPCIONES: Record<string, string> = {
  'agente/pantalla.tsx':
    'El asistente es un chat (#1163): el `h1` es `sr-only` porque la pantalla ' +
    'tiene que sentirse como abrir ChatGPT — visible aparecía cuatro veces en ' +
    'los primeros 300 px y empujaba la conversación 168 px hacia abajo. Con la ' +
    'miga fuera (#1323) el sr-only es además el único título de la pantalla: ' +
    'la conversación no compite con un encabezado. No se le pone título ' +
    'visible: se queda sin uno, que es la decisión.',
  'aceptar-invitacion.tsx':
    'Página pública, fuera del shell (#1323): tres estados excluyentes ' +
    '(aceptada, por aceptar, inválida) y ninguno es una pantalla del producto ' +
    'con su encabezado y su acción.',
  'entrar-local/entrar-local-client.tsx':
    'Puerta del ambiente local, fuera del shell (#1323): se ve SIN sesión y ' +
    'sin navegación, así que la envoltura —que es la gramática de adentro— ' +
    'no le aplica. Igual que aceptar-invitacion.',
};

function fuentes(dir: string, acc: string[] = []): string[] {
  for (const entrada of readdirSync(dir)) {
    const ruta = join(dir, entrada);
    if (statSync(ruta).isDirectory()) fuentes(ruta, acc);
    else if (entrada.endsWith('.tsx')) acc.push(ruta);
  }
  return acc;
}

/** La ruta como se escribe en EXCEPCIONES: relativa a components o a app.
    Fuera de la raíz del web —los fixtures de tmpdir— queda el nombre del archivo. */
const RAIZ_WEB = join(__dirname, '..');
function corto(archivo: string): string {
  const relativo = archivo.startsWith(RAIZ_WEB + '/') ? archivo.slice(RAIZ_WEB.length + 1) : '';
  if (/^(components|app)\//.test(relativo)) return relativo.split('/').slice(1).join('/');
  return archivo.split('/').pop()!;
}

/**
 * Los archivos con un `<h1` en la fuente limpia, sin contar los que la
 * envoltura dibuja. `EncabezadoDePagina` vive en `packages/ui`, así que
 * ningún archivo de acá la contiene: si un `<h1` aparece en la fuente, es
 * un título dibujado a mano.
 */
function titulosSueltos(raices: string[]): string[] {
  const sueltos: string[] = [];
  for (const raiz of raices) {
    for (const archivo of fuentes(raiz)) {
      const nombre = corto(archivo);
      if (nombre in EXCEPCIONES) continue;
      const n = (fuenteLimpia(readFileSync(archivo, 'utf8')).match(/<h1\b/g) ?? []).length;
      if (n > 0) sueltos.push(`${nombre}: ${n} <h1> a mano`);
    }
  }
  return sueltos;
}

describe('todas las pantallas empiezan igual (#1323)', () => {
  const archivos = fuentes(COMPONENTES);

  it('hay pantallas que mirar', () => {
    expect(archivos.length).toBeGreaterThan(25);
  });

  it('ninguna pantalla dibuja su título fuera de la envoltura', () => {
    const propios = titulosSueltos([COMPONENTES, APP]);
    expect(
      propios,
      'Pantallas con su propio <h1>:\n  ' +
        propios.join('\n  ') +
        '\nUsa EncabezadoDePagina (#1323): el título es el único «dónde estoy», ' +
        'y dos formas de escribirlo es exactamente lo que hacía ver el producto ' +
        'como un andamio. Si de verdad no es una pantalla del producto —una ' +
        'página pública, un chat a pantalla llena— agrégala a EXCEPCIONES con el ' +
        'motivo.',
    ).toEqual([]);
  });

  it('la envoltura se usa de verdad, no solo existe', () => {
    // Un componente que nadie usa es peor que no tenerlo: da la sensación
    // de que el problema está resuelto.
    const usos = archivos.filter((a) => readFileSync(a, 'utf8').includes('<EncabezadoDePagina')).length;
    expect(usos).toBeGreaterThanOrEqual(25);
  });

  it('la lista de excepciones no junta polvo', () => {
    const nombres = new Set([...fuentes(COMPONENTES), ...fuentes(APP)].map(corto));
    const sobrantes = Object.keys(EXCEPCIONES).filter((e) => !nombres.has(e));
    expect(sobrantes, `excepciones de archivos que ya no existen: ${sobrantes.join(', ')}`).toEqual([]);
  });

  it('cada excepción trae su motivo escrito', () => {
    for (const [nombre, motivo] of Object.entries(EXCEPCIONES)) {
      expect(motivo.length, `el motivo de ${nombre} es muy corto`).toBeGreaterThan(40);
    }
  });

  it('una excepción que ya no hace falta pone la prueba roja', () => {
    // El trinquete por los dos lados (#588): una lista que solo crece se
    // afloja sola. Si el archivo dejó de dibujar su `<h1>`, la entrada baja.
    for (const [nombre, raiz] of [
      ['agente/pantalla.tsx', join(COMPONENTES, 'agente', 'pantalla.tsx')],
      ['aceptar-invitacion.tsx', join(COMPONENTES, 'aceptar-invitacion.tsx')],
      ['entrar-local/entrar-local-client.tsx', join(APP, 'entrar-local', 'entrar-local-client.tsx')],
    ] as const) {
      const tiene = /<h1\b/.test(fuenteLimpia(readFileSync(raiz, 'utf8')));
      expect(tiene, `${nombre} ya no dibuja <h1>: su excepción sobra y baja`).toBe(true);
    }
  });

  it('la guarda ve un título nuevo aunque el archivo sea otro', () => {
    // La prueba del escáner mismo: si esto se rompe, la afirmación de arriba
    // deja de significar lo que dice. Un `<h1` dentro de un comentario no
    // cuenta — para eso se limpia la fuente (#569).
    const directorio = mkdtempSync(join(tmpdir(), 'iaxti-titulos-'));
    const archivo = join(directorio, 'pantalla-nueva.tsx');
    try {
      writeFileSync(
        archivo,
        [
          '// Un comentario que cita <h1> no es un título.',
          'export function PantallaNueva() {',
          '  return <h1 className="text-titulo">A mano</h1>;',
          '}',
        ].join('\n'),
      );
      expect(titulosSueltos([directorio])).toEqual(['pantalla-nueva.tsx: 1 <h1> a mano']);
      writeFileSync(archivo, 'export function PantallaNueva() { return null; }');
      expect(titulosSueltos([directorio])).toEqual([]);
    } finally {
      rmSync(directorio, { recursive: true, force: true });
    }
  });
});
