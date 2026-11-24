import { describe, expect, it } from 'vitest';
import {
  CATALOGO_DE_VISTAS,
  INSTRUCCION_DE_VISTA,
  extraerVista,
  vistaConfiable,
  vistaValida,
} from '../application/vistas';

/**
 * Las vistas del asistente (#1380): lo que se prueba acá es la FRONTERA, no
 * que el modelo dibuje bonito —eso lo dirá el uso en staging.
 *
 * La promesa del catálogo: la IA puede componer presentación con componentes
 * Mesón, y NO PUEDE componer nada más. Un spec que trate de hacer algo que no
 * sea mostrar datos —una acción, una expresión, un tamaño descontrolado— se
 * descarta entero y la respuesta queda en prosa, como siempre.
 */

const TABLA = {
  root: 'v1',
  elements: {
    v1: {
      type: 'Tabla',
      props: {
        titulo: 'Contactos con la ventana abierta',
        columnas: ['Contacto', 'Teléfono', 'Ventana'],
        filas: [
          ['María Paz', '+56 9 1234 5678', '2 h'],
          ['Jorge', '+56 9 8765 4321', '1 h 30'],
        ],
        mono: [false, true, true],
      },
    },
  },
};

const ZONA = {
  root: 'z',
  elements: {
    z: { type: 'Zona', props: { titulo: 'Cómo va el mes' }, children: ['m1', 'm2'] },
    m1: { type: 'Metrica', props: { rotulo: 'Conversaciones', valor: 128 } },
    m2: { type: 'Metrica', props: { rotulo: 'Contestadas', valor: '96', detalle: 'tres sin respuesta' } },
  },
};

describe('el catálogo deja pasar lo que declara', () => {
  it('una tabla con datos de una herramienta valida', () => {
    expect(vistaValida(JSON.stringify(TABLA))).toEqual(TABLA);
  });

  it('una zona con métricas valida, con hijos y sin children en las hojas', () => {
    expect(vistaValida(JSON.stringify(ZONA))).toEqual(ZONA);
  });

  it('la vista que vuelve del navegador se revalida igual: objeto y no texto', () => {
    expect(vistaConfiable(ZONA)).toEqual(ZONA);
    expect(vistaConfiable('no soy un spec')).toBeNull();
  });
});

describe('la frontera: lo que NO puede expresar, no llega', () => {
  it('un componente que no está en el catálogo se descarta', () => {
    const r = vistaValida(
      JSON.stringify({ root: 'v', elements: { v: { type: 'Boton', props: { texto: 'Borrar todo' } } } }),
    );
    expect(r).toBeNull();
  });

  it('una expresión es un objeto donde el schema pide un string: no pasa', () => {
    const r = vistaValida(
      JSON.stringify({
        root: 'v',
        elements: { v: { type: 'Metrica', props: { rotulo: 'x', valor: { $state: '/algo' } } } },
      }),
    );
    expect(r).toBeNull();
  });

  it('las claves que el spec del piloto no tiene se botan y no se interpretan', () => {
    const r = vistaValida(
      JSON.stringify({
        root: 'v',
        elements: {
          v: {
            type: 'Metrica',
            props: { rotulo: 'x', valor: '1' },
            // Que el modelo «intente» acciones o repeticiones: el schema no
            // las conoce, así que no existen para el que dibuja.
            on: { press: [{ action: 'borrar_todo' }] },
            repeat: { statePath: '/filas' },
            visible: { $state: '/mostrar' },
          },
        },
      }),
    );
    // La vista pasa —no había nada mal armado— pero SIN lo que no existe.
    expect(r).not.toBeNull();
    expect(Object.keys(r!.elements.v)).toEqual(['type', 'props']);
  });

  it('más elementos que el techo del piloto se descartan', () => {
    const elementos: Record<string, unknown> = {};
    for (let i = 0; i < 30; i++) {
      elementos[`m${i}`] = { type: 'Metrica', props: { rotulo: 'x', valor: String(i) } };
    }
    expect(vistaValida(JSON.stringify({ root: 'm0', elements: elementos }))).toBeNull();
  });

  it('una fila con celdas de más que el catálogo permite no llega', () => {
    const r = vistaValida(
      JSON.stringify({
        root: 'v',
        elements: {
          v: { type: 'Tabla', props: { columnas: ['a'], filas: [Array(8).fill('x')] } },
        },
      }),
    );
    expect(r).toBeNull();
  });

  it('un hijo que apunta a nadie se descarta', () => {
    const r = vistaValida(
      JSON.stringify({ root: 'z', elements: { z: { type: 'Zona', props: {}, children: ['fantasma'] } } }),
    );
    expect(r).toBeNull();
  });
});

describe('la vista se separa del texto de la respuesta', () => {
  const RESPUESTA = [
    'Tienes dos conversaciones por contestar dentro de la ventana:',
    '',
    '```vista',
    JSON.stringify(TABLA),
    '```',
  ].join('\n');

  it('sale del texto limpio y llega como vista', () => {
    const { texto, vista } = extraerVista(RESPUESTA);
    expect(texto).toBe('Tienes dos conversaciones por contestar dentro de la ventana:');
    expect(vista).toEqual(TABLA);
  });

  it('con dos bloques, el que cierra la respuesta es el que se muestra', () => {
    const { vista } = extraerVista(['```vista', '{"root":"v"', '```', 'x', '```vista', JSON.stringify(TABLA), '```'].join('\n'));
    expect(vista).toEqual(TABLA);
  });

  it('un bloque con JSON roto se botan entero: la prosa queda, sin el bloque', () => {
    const { texto, vista } = extraerVista(['Holo.', '', '```vista', '{"root":', '```'].join('\n'));
    expect(texto).toBe('Holo.');
    expect(vista).toBeNull();
  });

  it('un bloque con algo que no es una vista tampoco se muestra', () => {
    const { texto, vista } = extraerVista(['Holo.', '', '```vista', 'hola', '```'].join('\n'));
    expect(texto).toBe('Holo.');
    expect(vista).toBeNull();
  });

  it('sin bloque, el texto no se toca', () => {
    const { texto, vista } = extraerVista('Una respuesta normal, con ``` de otros lados quizás.');
    expect(texto).toBe('Una respuesta normal, con ``` de otros lados quizás.');
    expect(vista).toBeNull();
  });
});

describe('la instrucción y el catálogo no derivan', () => {
  it('cada componente del catálogo aparece en la instrucción que se le da al modelo', () => {
    for (const nombre of CATALOGO_DE_VISTAS.componentNames) {
      expect(INSTRUCCION_DE_VISTA, `${nombre} tiene que estar en la instrucción`).toContain(nombre);
    }
  });

  it('y las acciones no existen: el catálogo no declara ninguna', () => {
    expect(CATALOGO_DE_VISTAS.actionNames).toEqual([]);
  });
});
