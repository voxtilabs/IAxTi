import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { variablesQueEntregaElCompose } from '@iaxti/core';
import { ENV_KEYS } from '../application/models';
import { PROVIDERS } from '../domain/config';

/**
 * Cada llave que `ENV_KEYS` declara tiene que llegar al contenedor (#633).
 *
 * Esta guarda existe porque la general no puede verlo, y el hueco costó caro:
 * `providerAvailable` lee `process.env[ENV_KEYS[provider]]` —el nombre está en el
 * VALOR de un objeto, no en el código—, y el escáner de
 * `packages/core/tests/variables-del-despliegue.test.ts` busca `process.env.X` y
 * desestructuración. `GOOGLE_GENERATIVE_AI_API_KEY` y `GLM_API_KEY` aparecían
 * porque están escritas literales en otra parte; `ANTHROPIC_API_KEY` no, y por eso
 * fue la única que se cayó de los dos composes sin que nada avisara.
 *
 * Lo que se veía desde afuera: elegir Anthropic dejaba al asistente sin
 * contestar, con «Algo falló de nuestro lado». La llave estaba cargada en
 * Dokploy; lo que no estaba era el renglón que la mete al contenedor. Mismo
 * patrón de siempre —declarado en un lado, aplicado en ninguno— con el agravante
 * de que la guarda contra ese patrón tenía el hueco justo acá.
 *
 * Por qué vive en este módulo y no en `core`: el dueño de la lectura dinámica es
 * el dueño de su guarda. Enseñarle al escáner general a adivinar qué cadenas de
 * qué objetos son nombres de variables es la clase de astucia que falla en
 * silencio; esto pregunta lo que de verdad importa, con la lista de verdad.
 */
const RAIZ = join(__dirname, '..', '..', '..', '..');
const COMPOSES = {
  staging: join(RAIZ, 'infra', 'dokploy', 'docker-compose.staging.yml'),
  producción: join(RAIZ, 'infra', 'dokploy', 'docker-compose.prod.yml'),
};

describe('las llaves de los proveedores de IA llegan al contenedor (#633)', () => {
  it('ENV_KEYS cubre a TODOS los proveedores: uno sin llave no se puede diagnosticar', () => {
    // Si alguien agrega un proveedor y se olvida de su variable, el diagnóstico
    // de la IA (#614) no tendría qué nombrar y la pantalla diría "configura
    // undefined".
    for (const p of PROVIDERS) {
      expect(ENV_KEYS[p], `el proveedor "${p}" no declara su variable en ENV_KEYS`).toBeTruthy();
    }
  });

  for (const [ambiente, ruta] of Object.entries(COMPOSES)) {
    it(`el compose de ${ambiente} entrega las ${PROVIDERS.length} llaves`, () => {
      const entregadas = variablesQueEntregaElCompose(ruta);
      const faltan = PROVIDERS.map((p) => ENV_KEYS[p]).filter((v) => !entregadas.has(v));
      expect(
        faltan,
        `Estas llaves las LEE el código y el compose de ${ambiente} no las pasa, así que no ` +
          'llegan al contenedor aunque estén cargadas en Dokploy. El proveedor queda muerto y ' +
          'el error que ve el negocio es genérico:\n  ' +
          faltan.join('\n  '),
      ).toEqual([]);
    });
  }
});
