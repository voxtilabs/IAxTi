import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fuenteLimpia } from '@iaxti/core/testing';

/**
 * A un contacto con teléfono no se le dice «Sin nombre» (#1139).
 *
 * `nombreVisible()` existe en `packages/ui` justo para esto: devuelve el
 * nombre si lo hay, el teléfono si no, y el canal con su cola de identidad
 * cuando tampoco hay teléfono. «Sin nombre» es su ÚLTIMO recurso, no el
 * primero.
 *
 * Lo que costó: la portada listaba tres conversaciones esperando respuesta y
 * las tres decían «Sin nombre», teniendo el teléfono en el mismo objeto. Un
 * WhatsApp nuevo llega sin nombre —el caso normal—, así que esa lista no
 * identificaba a nadie. Y `dar-una-hora` escribía «Sin nombre +56955550101»,
 * que ocupa el doble y no dice más que el número solo.
 *
 * Es la tercera vez que aparece el mismo defecto en un sitio distinto: #1105
 * en la lista de la bandeja, #1120 en la cabecera y la ficha, y esto. Por eso
 * la guarda y no solo el arreglo.
 */
const RAIZ = join(__dirname, '..');

/**
 * Dónde «Sin nombre» es correcto, con su motivo.
 *
 * No crece sin uno escrito. Lo que distingue estos casos es que la cosa sin
 * nombre NO es un contacto: no tiene teléfono que mostrar en su lugar.
 */
const CORRECTO: Record<string, string> = {
  'components/canales.tsx':
    'Es el nombre de un EMISOR de WhatsApp, no de una persona: lo que va debajo es su id, ' +
    'no un teléfono al que escribirle. No hay nombre alternativo que mostrar.',
  'components/equipo.tsx':
    'Es alguien del equipo y ya cae antes a su correo (`nombre ?? email ?? ...`). ' +
    'Quien llega a «Sin nombre» no tiene ni nombre ni correo, que es el final de la cadena.',
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

describe('a nadie se le dice «Sin nombre» (#1139)', () => {
  it('ningún componente lo escribe a mano sin motivo', () => {
    const culpables: string[] = [];
    for (const archivo of fuentes(join(RAIZ, 'components'))) {
      const rel = archivo.slice(RAIZ.length + 1).replaceAll('\\', '/');
      if (CORRECTO[rel]) continue;
      if (fuenteLimpia(readFileSync(archivo, 'utf8')).includes("'Sin nombre'")) {
        culpables.push(rel);
      }
    }
    expect(culpables).toEqual([]);
  });

  it('cada excepción dice POR QUÉ, y el archivo todavía existe', () => {
    // Una excepción que sobrevive al archivo que la motivaba es una regla
    // ablandada sin que nadie lo decidiera.
    for (const [rel, motivo] of Object.entries(CORRECTO)) {
      expect(motivo.length, `${rel} necesita un motivo escrito`).toBeGreaterThan(60);
      const fuente = fuenteLimpia(readFileSync(join(RAIZ, rel), 'utf8'));
      expect(fuente, `${rel} ya no dice «Sin nombre»: saca la excepción`).toContain("'Sin nombre'");
    }
  });

  it('`nombreVisible` sigue cayendo a «Sin nombre» solo al final', () => {
    const canal = fuenteLimpia(
      readFileSync(join(RAIZ, '..', '..', 'packages', 'ui', 'src', 'react', 'canal.tsx'), 'utf8'),
    );
    // El orden importa: nombre, teléfono, canal, y recién ahí el último recurso.
    expect(canal.indexOf('input.phone')).toBeLessThan(canal.indexOf("'Sin nombre'"));
  });
});
