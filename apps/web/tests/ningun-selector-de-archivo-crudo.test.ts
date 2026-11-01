import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fuenteLimpia } from '@iaxti/core/testing';

/**
 * Ningún `<input type="file">` se dibuja con la piel del sistema (#1144).
 *
 * El nativo se pinta con los controles del sistema operativo y, peor, con su
 * IDIOMA: en una pantalla en español decía «Choose Files · No file chosen».
 * Es el mismo motivo por el que #537 prohibió los checkbox nativos —«el
 * nativo se pinta con los colores del sistema operativo y en modo noche
 * queda un cuadrado blanco»— agravado, porque un cuadrado gris desentona y
 * un texto en inglés se lee como que la pantalla no está terminada.
 *
 * Había CUATRO sitios con TRES patrones: dos lo resolvían bien a mano, uno a
 * medias con clases `file:` —el botón con la piel de Pulso y el texto de al
 * lado todavía del navegador— y uno crudo. La quinta copia habría sido el
 * mismo error con otra sintaxis, así que ahora hay primitiva.
 *
 * Lo que se exige no es «usa la primitiva»: es que el input **no se vea**.
 * Un paperclip en la bandeja y un «elige un archivo» dentro de un párrafo son
 * formas legítimas y distintas; lo que no es legítimo es dejar que lo pinte
 * el navegador.
 */
const RAIZ = join(__dirname, '..');

function fuentes(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const ruta = join(dir, e);
    if (statSync(ruta).isDirectory()) fuentes(ruta, acc);
    else if (e.endsWith('.tsx')) acc.push(ruta);
  }
  return acc;
}

describe('ningún selector de archivo crudo (#1144)', () => {
  it('todo `type="file"` va oculto: lo que se ve lo pone el sistema de diseño', () => {
    const crudos: string[] = [];
    for (const archivo of fuentes(join(RAIZ, 'components'))) {
      const fuente = fuenteLimpia(readFileSync(archivo, 'utf8'));
      let desde = 0;
      for (;;) {
        const i = fuente.indexOf('type="file"', desde);
        if (i === -1) break;
        desde = i + 1;
        // El `<input …>` completo al que pertenece: desde el `<input` anterior
        // hasta el `/>` siguiente.
        const abre = fuente.lastIndexOf('<input', i);
        const cierra = fuente.indexOf('/>', i);
        const etiqueta = fuente.slice(abre, cierra);
        if (!/className="[^"]*\b(sr-only|hidden)\b/.test(etiqueta)) {
          crudos.push(`${archivo.slice(RAIZ.length + 1).replaceAll('\\', '/')}`);
        }
      }
    }
    expect(crudos).toEqual([]);
  });

  it('la primitiva esconde el input y no lo simula con un botón', () => {
    // Un `<button onClick={() => input.click()}>` se ve igual y pierde
    // arrastrar y soltar, el teclado y el lector de pantalla. El control
    // tiene que seguir siendo el input, solo que sin pintar.
    const prim = fuenteLimpia(
      readFileSync(join(RAIZ, '..', '..', 'packages', 'ui', 'src', 'react', 'ui', 'elegir-archivo.tsx'), 'utf8'),
    );
    expect(prim).toContain('className="sr-only"');
    expect(prim).toContain('htmlFor={id}');
    expect(prim).not.toContain('.click()');
  });
});
