import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fuenteLimpia } from '@iaxti/core/testing';

/**
 * Los atajos de la bandeja están escritos UNA vez (#1111).
 *
 * Estaban en el diálogo de ayuda. Cuando el panel de espera empezó a
 * mostrarlos también, copiarlos habría dejado dos listas; y la que se
 * desincroniza es siempre la que nadie está mirando. Es el defecto más común
 * de este repo —declarado en un lado, no aplicado en el otro— y acá se
 * presenta disfrazado de ayuda: el usuario lee una lista de atajos que ya no
 * son todos los atajos, y no tiene forma de saberlo.
 *
 * La guarda es de FUENTE porque la pregunta es «¿está escrito dos veces?».
 */
const DIR = join(__dirname, '..', 'components', 'bandeja');
const DUEÑO = 'atajos-de-la-bandeja.tsx';

describe('los atajos de la bandeja', () => {
  it('se escriben en un solo archivo', () => {
    const dueño = fuenteLimpia(readFileSync(join(DIR, DUEÑO), 'utf8'));
    // Las frases, tal como las lee el usuario.
    const frases = [...dueño.matchAll(/que: '([^']+)'/g)].map((m) => m[1]);
    expect(frases.length).toBeGreaterThanOrEqual(4);

    const copiones: string[] = [];
    for (const archivo of readdirSync(DIR).filter((f) => f.endsWith('.tsx') && f !== DUEÑO)) {
      const fuente = fuenteLimpia(readFileSync(join(DIR, archivo), 'utf8'));
      if (frases.some((f) => fuente.includes(f))) copiones.push(archivo);
    }
    expect(copiones).toEqual([]);
  });

  it('cada atajo que la lista promete, lo implementa el keydown de la bandeja', () => {
    // Que no haya copias no sirve si la lista promete una tecla que nadie
    // escucha: eso es la misma clase de defecto, al revés.
    const bandeja = fuenteLimpia(readFileSync(join(DIR, 'bandeja.tsx'), 'utf8'));
    for (const tecla of ['j', 'k', 'e', '?']) {
      expect(bandeja, `la tecla ${tecla} no aparece en bandeja.tsx`).toContain(`'${tecla}'`);
    }
  });
});
