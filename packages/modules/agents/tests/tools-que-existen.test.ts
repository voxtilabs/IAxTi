import { describe, expect, it } from 'vitest';
import { ModuleRegistry } from '@iaxti/core';
import { DEFINICIONES, OBJETIVOS } from '../domain/objetivo';
import {
  HERRAMIENTAS_DE_LECTURA,
  HERRAMIENTAS_QUE_ESCRIBEN_HABILITADAS,
} from '../application/herramientas';

/**
 * Una herramienta nombrada en un lado y declarada en ninguno no falla: se
 * filtra en silencio y la función queda sin efecto.
 *
 * Me pasó estrenando los objetivos (#315): puse `calendar.agendar`,
 * `crm.buscar_contacto`, `knowledge.buscar` — ninguna existe. El registry las
 * descartaba calladas, así que los tests pasaban, nada reventaba, y el
 * objetivo aportaba CERO herramientas. Exactamente el patrón que el issue
 * venía a arreglar, cometido al arreglarlo.
 *
 * Estas guardas cruzan las tres listas que tienen que coincidir y que hoy
 * nadie comparaba.
 */

const registry = new ModuleRegistry().load();

/** Lo que los módulos DECLARAN: la única fuente de nombres válidos. */
const declaradas = new Set<string>(
  registry.health().flatMap((m) => registry.manifest(m.id).tools ?? []),
);

/** Lo que de verdad se puede ejecutar: leer + las de escribir habilitadas. */
const ejecutables = new Set<string>([
  ...Object.keys(HERRAMIENTAS_DE_LECTURA),
  ...Object.keys(HERRAMIENTAS_QUE_ESCRIBEN_HABILITADAS),
]);

describe('las herramientas existen de verdad', () => {
  it('cada tool de un objetivo está declarada en el manifiesto de su módulo', () => {
    for (const id of OBJETIVOS) {
      for (const tool of DEFINICIONES[id].tools) {
        expect(
          declaradas.has(tool),
          `El objetivo "${id}" pide "${tool}" y ningún módulo la declara. ` +
            'Se filtraría en silencio y el objetivo quedaría sin herramientas.',
        ).toBe(true);
      }
    }
  });

  it('y además se puede ejecutar: ofrecer una que nadie ejecuta es peor que no ofrecerla', () => {
    // Si el modelo la puede pedir pero `ejecutarHerramienta` no la conoce,
    // la conversación se gasta un paso para recibir "no existe".
    for (const id of OBJETIVOS) {
      for (const tool of DEFINICIONES[id].tools) {
        expect(
          ejecutables.has(tool),
          `El objetivo "${id}" pide "${tool}", que está declarada pero NO se ejecuta.`,
        ).toBe(true);
      }
    }
  });

  it('toda herramienta ejecutable está declarada por algún módulo', () => {
    // Al revés: una habilitada que ningún manifiesto declara nunca llega a
    // ofrecerse. Fue el caso de `crm.create_activity` —está en el código, en
    // los tests y en la ADR-0017— mientras el manifiesto de crm decía
    // `crm.create_task`. Una de las DOS únicas herramientas de escritura que
    // la IA tiene permitidas estaba muerta y nada lo decía.
    for (const tool of ejecutables) {
      expect(
        declaradas.has(tool),
        `"${tool}" se puede ejecutar pero ningún módulo la declara: jamás se ofrece.`,
      ).toBe(true);
    }
  });

  it('el objetivo no le pide al modelo lo que ADR-0017 le prohíbe', () => {
    // La primera versión de `agendar` decía "cierra confirmando día y hora",
    // y tomar la hora es justo lo que la IA no puede hacer (SPEC §16: la IA
    // OFRECE máximo tres horarios). Un prompt que pide lo prohibido no falla:
    // consigue que el modelo lo prometa igual, sin tool que lo respalde.
    expect(DEFINICIONES.agendar.tools).not.toContain('calendar.book');
    expect(DEFINICIONES.agendar.instruccion).toContain('no tomas la hora');
    expect(DEFINICIONES.cobrar.tools).not.toContain('payments.create_link');
    expect(DEFINICIONES.cobrar.instruccion).toContain('no mandas links de pago');
  });
});
