import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fuenteLimpia } from '@iaxti/core/testing';

/**
 * El libro de auditoría distingue «buscando» de «no hay nada» (#588).
 *
 * ## Lo que estaba mal
 *
 * Un solo pixel para tres cosas. La tabla en blanco servía para la primera
 * carga, para «estoy buscando» y para «no hay registros». El issue lo anotó
 * así —«es la pantalla donde alguien va a buscar qué pasó, y no distingue no
 * hay registros de no cargó»— y la excepción de la guarda de esqueletos lo
 * decía con más precisión: «`cargando` solo apaga el botón Buscar; la tabla no
 * tiene esqueleto, así que el mismo pixel sirve para buscando y para no hay
 * nada».
 *
 * Duele más acá que en otras pantallas: al libro de auditoría se entra cuando
 * algo pasó y hay que saber qué. Una tabla vacía que puede significar «nadie
 * hizo nada» o «no cargó» no sirve para decidir, y en la primera lectura es
 * peor que un error — **parece una respuesta**.
 *
 * ## Por qué esto escanea la fuente y no renderiza
 *
 * `packages/ui` no tiene entorno DOM: sus pruebas validan por el escáner de
 * hex, el typecheck y la lógica pura, y así lo dice `componentes.test.ts`.
 * Montar jsdom para este componente sería traer un entorno nuevo al paquete
 * por una pantalla.
 *
 * Lo que esto SÍ caza es que alguien «simplifique» los tres estados de vuelta
 * a uno, que es exactamente cómo llegaron a ser uno.
 */
const FUENTE = fuenteLimpia(
  readFileSync(join(__dirname, '..', 'src', 'react', 'audit-explorer.tsx'), 'utf8'),
);

describe('el libro de auditoría no confunde sus estados (#588)', () => {
  it('la guarda está mirando algo', () => {
    // Anti-vacuidad: si el archivo se moviera, lo de abajo pasaría sin medir.
    expect(FUENTE.length).toBeGreaterThan(2000);
    expect(FUENTE).toContain('AuditExplorer');
  });

  it('tiene esqueleto mientras busca', () => {
    expect(FUENTE).toContain('Skeleton');
    // Y atado a `cargando`, no suelto en cualquier parte del archivo.
    expect(FUENTE).toMatch(/\{cargando && \(/);
  });

  it('tiene EstadoVacio cuando no hay nada, y NO mientras carga', () => {
    expect(FUENTE).toContain('EstadoVacio');
    // `!cargando` en la condición es lo que evita el peor de los tres
    // estados: el vacío mostrándose mientras todavía se está buscando, que
    // afirma «no hay nada» antes de saberlo.
    expect(FUENTE).toMatch(/!cargando && filas !== null && filas\.length === 0/);
  });

  it('las filas viejas NO se muestran mientras busca', () => {
    /**
     * Lo normal en una tabla es dejar el resultado anterior mientras llega el
     * nuevo. Acá es peor: las filas que se ven no coinciden con los filtros
     * que la persona acaba de escribir, y en un libro de auditoría eso es una
     * respuesta equivocada a una pregunta concreta — alguien puede concluir
     * que algo pasó, o que no pasó, mirando filas de otra consulta.
     */
    expect(FUENTE).toMatch(/\(cargando \? \[\] : filas \?\? \[\]\)\.map\(/);
    // Y que no haya quedado la versión vieja por ningún lado.
    expect(FUENTE).not.toMatch(/\{\(filas \?\? \[\]\)\.map\(/);
  });

  it('el estado vacío ofrece una ACCIÓN, no solo una frase', () => {
    // La regla de Pulso: qué va a aparecer ahí y la acción que lo provoca. Un
    // vacío que solo dice «no hay nada» es un callejón.
    expect(FUENTE).toContain('limpiarYBuscar');
    // Y la acción limpia Y busca: dejar los campos en blanco con la tabla
    // igual le pediría a la persona que adivine que ahora hay que apretar
    // Buscar.
    expect(FUENTE).toMatch(/limpiarYBuscar = useCallback\(\(\) => \{[\s\S]{0,200}setFiltros\(\{\}\)/);
    /**
     * Y que busque sin filtros, escrito como esté escrito.
     *
     * La primera versión exigía `search({})` literal y se puso roja cuando
     * #799 metió la paginación y la llamada pasó por `traer({})`. No se había
     * roto nada: la acción sigue limpiando y buscando. Una guarda de fuente
     * que se cae porque mejoró lo que vigila enseña a apagarla, que es lo peor
     * que le puede pasar a una prueba (`.claude/rules/testing.md`).
     *
     * Lo que importa es que la llamada vaya SIN filtros —el `({})`—, no cómo
     * se llame la función que la hace.
     */
    expect(FUENTE).toMatch(/limpiarYBuscar = useCallback\(\(\) => \{[\s\S]{0,400}\w+\(\{\}\)/);
  });
});
