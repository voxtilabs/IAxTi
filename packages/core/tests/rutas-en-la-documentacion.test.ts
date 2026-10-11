import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findModulesDir } from '../src/manifest';
import { rutasCitadas, rutasQueNoExisten } from '../src/rutas-en-la-documentacion';

/**
 * Lo que la documentación cita, existe (#817).
 *
 * El runbook de producción es lo que alguien sigue a las tres de la mañana y
 * los baselines son lo que se muestra cuando preguntan por cumplimiento. Una
 * ruta citada que ya no está convierte una instrucción en un callejón, y
 * nadie se entera hasta que la necesita.
 */
const RAIZ = join(findModulesDir(), '..', '..');

describe('la documentación no cita archivos que no existen', () => {
  it('ni una ruta rota en docs, .claude y el README', () => {
    const rotas = rutasQueNoExisten(['docs', '.claude', 'README.md'], RAIZ);
    const listado = rotas.map((r) => `${r.documento}:${r.linea} → ${r.ruta}`);
    expect(
      listado,
      'Rutas que la documentación nombra y no existen. Corrige la cita, o crea lo que ' +
        'promete:\n  ' + listado.join('\n  '),
    ).toEqual([]);
  });

  /**
   * Las cuatro de abajo son contra la vacuidad: un `toEqual([])` también lo
   * satisface un escáner ciego, y de eso se trató toda la noche del 10/10.
   */
  it('la guarda está mirando algo: hay citas de verdad en el SPEC', () => {
    // Si el escáner encontrara CERO citas, el test de arriba estaría verde sin
    // mirar nada. Ésa es la aserción positiva que no puede pasar por omisión.
    const spec = readFileSync(join(RAIZ, 'docs', 'SPEC.md'), 'utf8');
    expect(rutasCitadas(spec).length).toBeGreaterThan(10);
  });

  it('encuentra una ruta citada entre comillas', () => {
    const encontradas = rutasCitadas('El runbook vive en `docs/runbooks/ANTES-DE-PRODUCCION.md`.');
    expect(encontradas).toEqual([{ linea: 1, ruta: 'docs/runbooks/ANTES-DE-PRODUCCION.md' }]);
  });

  it('una cita con número de línea se comprueba por el archivo', () => {
    expect(rutasCitadas('mira `apps/api/src/main.ts:42`')).toEqual([
      { linea: 1, ruta: 'apps/api/src/main.ts' },
    ]);
  });

  it('no cuenta plantillas ni cosas que no son rutas del repo', () => {
    const texto = [
      'una plantilla: `packages/modules/<id>/migrations/`',
      'un comando: `packages/modules/$ARGUMENTS/`',
      'una ruta de API: `/v1/conversations/:id`',
      'una cabecera: `X-Request-Id`',
      'un glob: `apps/**/*.tsx`',
      'un rango de prefijos: `docs/adr/0001`',
    ].join('\n');
    expect(rutasCitadas(texto)).toEqual([]);
  });

  it('la línea que reporta es la de verdad', () => {
    const texto = ['nada', 'nada', 'acá sí: `scripts/antes-de-empujar.sh`'].join('\n');
    expect(rutasCitadas(texto)).toEqual([{ linea: 3, ruta: 'scripts/antes-de-empujar.sh' }]);
  });
});
