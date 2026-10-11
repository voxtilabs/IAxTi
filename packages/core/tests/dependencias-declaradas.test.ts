import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { findModulesDir, loadAllManifests } from '../src/manifest';
import {
  importaSinDeclarar,
  modulosQueImporta,
  requeridasSinImport,
  REQUERIDAS_SIN_IMPORT,
} from '../src/dependencias-declaradas';

/**
 * El manifiesto es lo único que el registry lee para decidir si puede apagar
 * un módulo (SPEC §26 regla 4). Una dependencia que el código ejerce y el
 * manifiesto no declara no existe para esa comprobación (#821).
 */
const MODULES = findModulesDir();
const modulos = loadAllManifests(MODULES).map((m) => ({
  id: m.module.id,
  dir: join(MODULES, m.module.id),
  required: m.depends_on?.required ?? [],
  optional: m.depends_on?.optional ?? [],
}));

describe('las dependencias que el código ejerce están declaradas', () => {
  it('la guarda está mirando algo: hay módulos y hay imports entre ellos', () => {
    // Anti-vacuidad: si `loadAllManifests` o el escáner devolvieran nada, las
    // dos aserciones de abajo quedarían verdes sobre listas vacías.
    expect(modulos.length).toBeGreaterThan(15);
    const conImports = modulos.filter((m) => modulosQueImporta(m.dir).size > 0);
    expect(conImports.length).toBeGreaterThan(10);
  });

  it('ningún módulo importa a otro sin declararlo', () => {
    const huecos = importaSinDeclarar(modulos).map(
      (h) => `${h.modulo} importa ${h.dependencia} y no lo declara`,
    );
    expect(
      huecos,
      'El registry no puede negarse a apagar lo que el manifiesto no declara. Agrégalo a ' +
        '`required` si el código lo llama sin guarda, o a `optional` si degrada con ' +
        '`isActive`:\n  ' + huecos.join('\n  '),
    ).toEqual([]);
  });

  it('ninguna `required` sin import se queda sin motivo escrito', () => {
    const sobrantes = requeridasSinImport(modulos).map(
      (h) => `${h.modulo} declara ${h.dependencia} como required y no lo importa`,
    );
    expect(
      sobrantes,
      'Una `required` que el módulo no importa hace que el registry se niegue a un apagado ' +
        'legítimo. Pásala a `optional`, o anótala en REQUERIDAS_SIN_IMPORT con el motivo por ' +
        'el que la dependencia es real:\n  ' + sobrantes.join('\n  '),
    ).toEqual([]);
  });

  it('la lista de motivos no junta polvo: todas siguen declaradas y sin importar', () => {
    const vivas = new Set(
      modulos.flatMap((m) => {
        const importadas = modulosQueImporta(m.dir);
        return m.required.filter((d) => !importadas.has(d)).map((d) => `${m.id}→${d}`);
      }),
    );
    const sobrantes = Object.keys(REQUERIDAS_SIN_IMPORT).filter((k) => !vivas.has(k));
    expect(
      sobrantes,
      `Motivos de dependencias que ya no aplican: ${sobrantes.join(', ')}`,
    ).toEqual([]);
  });

  it('cada motivo trae texto, no una cadena vacía', () => {
    for (const [par, motivo] of Object.entries(REQUERIDAS_SIN_IMPORT)) {
      expect(motivo.trim().length, par).toBeGreaterThan(30);
    }
  });

  /**
   * El caso que la estrenó, escrito como prueba: `webchat` llama a
   * `conversations` sin guarda, y `conversations` NO es del núcleo, así que el
   * kill switch lo apagaba sin objeción mientras el widget seguía escribiendo.
   */
  it('webchat declara conversations, que es lo que llama sin guarda', () => {
    const webchat = modulos.find((m) => m.id === 'webchat')!;
    expect(modulosQueImporta(webchat.dir)).toContain('conversations');
    expect(webchat.required).toContain('conversations');
  });
});
