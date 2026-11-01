import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fuenteLimpia } from '@iaxti/core/testing';

/**
 * Una acción que borra no se dibuja como texto suelto (#1148).
 *
 * El botón tenía dos extremos para lo destructivo y nada en medio:
 * `fantasma` —callado y NEUTRO— y `destructivo` —relleno rojo—. El caso
 * común es el del medio: borrar una fila.
 *
 * Medido antes de esto: SIETE acciones destructivas usaban `fantasma` contra
 * DOS que usaban `destructivo`. En la fila de una etapa, «Borrar» quedaba
 * como texto negro suelto al lado de un «Guardar» con borde — la acción
 * peligrosa era el control MENOS marcado de la fila.
 *
 * Ninguno de los dos extremos servía: tres filas con tres botones rojos
 * gritan y el ojo deja de distinguir cuál es la de verdad peligrosa;
 * `fantasma` no distingue borrar de cancelar.
 *
 * Esta guarda es de FUENTE porque la pregunta es «¿está escrito?». Que se
 * VEA bien lo dicen las capturas.
 */
const RAIZ = join(__dirname, '..');

/** Lo que una acción destructiva dice. En el rótulo o en el manejador. */
const DESTRUCTIVO = /\b(Borrar|Eliminar|Quitar|Revocar|borrar|eliminar|quitar|revocar)\b/;

/**
 * Dónde `fantasma` con una de esas palabras es correcto, con su motivo.
 *
 * El criterio: la palabra aparece, pero el botón NO es el que destruye.
 */
const CORRECTO: Record<string, string> = {
  'components/bandeja/chat.tsx':
    'El «Quitar» saca el archivo que acabas de adjuntar ANTES de enviarlo: deshace una ' +
    'selección, no borra nada que exista. Pintarlo de peligro enseñaría que soltar un adjunto ' +
    'mal elegido es grave, y es lo contrario — tiene que ser barato.',

  'components/automatizaciones.tsx':
    'El «Quitar» saca un paso de la secuencia que se está editando y todavía no se guarda. ' +
    'Lo que destruye es el «Guardar» de después, y hasta entonces cerrar la pantalla lo deshace ' +
    'todo: marcar cada paso como peligroso gritaría en cada edición.',

  'components/google-calendar.tsx':
    'Son los dos botones del diálogo de confirmación: el que abre el diálogo y el «Volver» que ' +
    'lo cierra. El que de verdad revoca es el primario del `DialogFooter`, y ahí el peso SÍ ' +
    'corresponde porque ya estás confirmando.',
};

function fuentes(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const ruta = join(dir, e);
    if (statSync(ruta).isDirectory()) fuentes(ruta, acc);
    else if (e.endsWith('.tsx')) acc.push(ruta);
  }
  return acc;
}

describe('lo destructivo se lee como destructivo (#1148)', () => {
  it('ningún `fantasma` borra', () => {
    const culpables: string[] = [];
    for (const archivo of fuentes(join(RAIZ, 'components'))) {
      const rel = archivo.slice(RAIZ.length + 1).replaceAll('\\', '/');
      if (CORRECTO[rel]) continue;
      const fuente = fuenteLimpia(readFileSync(archivo, 'utf8'));
      let desde = 0;
      for (;;) {
        const i = fuente.indexOf('variant="fantasma"', desde);
        if (i === -1) break;
        desde = i + 1;
        const fin = fuente.indexOf('</Button>', i);
        if (fin === -1) continue;
        if (DESTRUCTIVO.test(fuente.slice(i, fin))) culpables.push(rel);
      }
    }
    expect([...new Set(culpables)]).toEqual([]);
  });

  it('la variante existe en el sistema y no es un `className` suelto', () => {
    const boton = fuenteLimpia(
      readFileSync(join(RAIZ, '..', '..', 'packages', 'ui', 'src', 'react', 'ui', 'button.tsx'), 'utf8'),
    );
    expect(boton).toContain("quitar: 'bg-transparent text-bad-text");
    // Sin relleno: si algún día se le pone fondo sólido, deja de ser el medio
    // y vuelve a ser `destructivo` con otro nombre.
    expect(boton).not.toContain("quitar: 'bg-bad");
  });

  it('cada excepción dice por qué y el archivo todavía la necesita', () => {
    for (const [rel, motivo] of Object.entries(CORRECTO)) {
      expect(motivo.length, `${rel} necesita un motivo escrito`).toBeGreaterThan(80);
      const fuente = fuenteLimpia(readFileSync(join(RAIZ, rel), 'utf8'));
      expect(fuente, `${rel} ya no tiene un fantasma destructivo: saca la excepción`)
        .toContain('variant="fantasma"');
    }
  });
});
