import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { findModulesDir, loadAllManifests } from '../src/manifest';
import { eventosDelCatalogo, eventosDelCatalogoEnArchivo } from '../src/catalogo-de-eventos';

/**
 * El catálogo de eventos del SPEC §24 y los manifiestos dicen lo mismo (#828).
 *
 * La regla está escrita al pie del propio catálogo —«agregar un evento es
 * editar el manifiesto del módulo que lo publica y esta lista»— y nada la
 * comprobaba. Es el tercer lado del triángulo: `eventos-declarados.test.ts`
 * cuida manifiesto↔código, y faltaba catálogo↔manifiesto, que es el lado que
 * lee una persona cuando pregunta «¿de qué me puedo enterar?».
 */
const MODULES = findModulesDir();
const SPEC = join(MODULES, '..', '..', 'docs', 'SPEC.md');

const delCatalogo = eventosDelCatalogoEnArchivo(SPEC);
const delManifiesto = new Set(
  loadAllManifests(MODULES).flatMap((m) => m.events?.publishes ?? []),
);

describe('el catálogo del SPEC §24 y los manifiestos dicen lo mismo', () => {
  it('la guarda está mirando algo: los dos lados traen eventos', () => {
    // Anti-vacuidad. Si el recorte del bloque fallara, las dos de abajo
    // quedarían verdes sobre conjuntos vacíos. El `eventosDelCatalogo` tira si
    // no encuentra sus marcadores, y esto además fija un piso.
    expect(delCatalogo.size).toBeGreaterThan(50);
    expect(delManifiesto.size).toBeGreaterThan(50);
  });

  it('el catálogo no promete eventos que ningún módulo declara', () => {
    const fantasmas = [...delCatalogo].filter((e) => !delManifiesto.has(e)).sort();
    expect(
      fantasmas,
      'El SPEC §24 los lista y ningún `events.publishes` los declara. Quien lea el catálogo y ' +
        'cablee un consumidor a uno de éstos espera para siempre, sin error y sin aviso:\n  ' +
        fantasmas.join('\n  '),
    ).toEqual([]);
  });

  it('y no le falta ninguno de los que se declaran', () => {
    const sinCatalogar = [...delManifiesto].filter((e) => !delCatalogo.has(e)).sort();
    expect(
      sinCatalogar,
      'Estos eventos se publican y el catálogo del SPEC §24 no los nombra. El catálogo se ' +
        'presenta como el contrato entre módulos: lo que no está ahí, para quien lo lea, no ' +
        'existe:\n  ' + sinCatalogar.join('\n  '),
    ).toEqual([]);
  });

  /**
   * Y que el recorte no se rompa en silencio. Era el modo de falla de
   * `panel-superadmin.test.ts` (#823): un `indexOf` que devuelve -1 deja un
   * bloque vacío y toda aserción negativa pasa.
   */
  it('si el bloque del catálogo se mueve, la guarda GRITA en vez de quedarse vacía', () => {
    expect(() => eventosDelCatalogo('# un SPEC sin catálogo de eventos')).toThrow(
      /no se encontró el bloque del catálogo/,
    );
  });

  it('lee los nombres del bloque y no del resto del documento', () => {
    const falso = [
      '```',
      'identity        user.registered · user.invited',
      'crm             contact.created',
      '```',
      '',
      'Agregar un evento es editar el manifiesto del módulo que lo publica y esta lista.',
      '',
      'Y acá abajo, fuera del bloque, un nombre que NO tiene que contar: fuera.del.bloque',
    ].join('\n');
    expect([...eventosDelCatalogo(falso)].sort()).toEqual([
      'contact.created',
      'user.invited',
      'user.registered',
    ]);
  });
});
