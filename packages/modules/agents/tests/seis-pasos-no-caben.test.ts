import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ESPERA_MAXIMA_MS } from '../application/models';

/**
 * El presupuesto del Agente General (#712).
 *
 * #688 le puso un reloj a toda llamada al proveedor —60 s— y estaba bien para
 * UNA respuesta. El Agente General no es una respuesta: es una conversación con
 * herramientas, y sus pasos ocurren **dentro de una sola llamada a `generate`**,
 * así que todos comparten el mismo presupuesto.
 *
 * Con el proveedor sano alcanzaba de sobra. Con NVIDIA encolando —medido el
 * 28/09: 139 s y 178 s para un «di hola» sin herramientas— el primer paso se
 * comía el presupuesto entero y la conversación se cortaba antes de empezar.
 * «La IA que hace IAs no va», textual.
 *
 * Esta prueba mira el código y no el comportamiento porque lo que se rompió no
 * fue la lógica: fue la relación entre dos números que viven en archivos
 * distintos. Eso no se cae en ninguna corrida, se cae en producción.
 */
const FUENTE = readFileSync(
  join(__dirname, '..', 'application', 'agente-general.ts'),
  'utf8',
);

function constante(nombre: string): number {
  return Number(new RegExp(`const ${nombre} = ([0-9_]+)`).exec(FUENTE)?.[1].replace(/_/g, ''));
}

describe('el Agente General tiene su propio reloj (#712)', () => {
  it('declara su presupuesto y no se queda con el de una respuesta suelta', () => {
    expect(FUENTE, 'sin esto hereda los 60 s del copiloto').toContain('esperaMaximaMs:');
    const pasos = constante('PASOS');
    const porPaso = constante('MS_POR_PASO');
    expect(pasos).toBeGreaterThan(1);
    expect(
      pasos * porPaso,
      `con ${pasos} pasos y ${porPaso} ms cada uno, el presupuesto tiene que superar al de una respuesta suelta (${ESPERA_MAXIMA_MS} ms)`,
    ).toBeGreaterThan(ESPERA_MAXIMA_MS);
  });

  it('el presupuesto sale de los pasos, no de un número suelto', () => {
    // Si alguien escribe `esperaMaximaMs: 180_000` a mano, el día que suba
    // `maxSteps` a ocho el presupuesto se queda corto y nadie lo relaciona.
    expect(FUENTE).toMatch(/esperaMaximaMs:\s*PASOS \* MS_POR_PASO/);
    expect(FUENTE).toMatch(/maxSteps:\s*PASOS/);
  });

  it('y no es eterno: un agente colgado también es un problema', () => {
    // El reloj existe porque sin él el panel giraba para siempre. Darle quince
    // minutos sería volver ahí por la puerta de atrás.
    expect(constante('PASOS') * constante('MS_POR_PASO')).toBeLessThanOrEqual(300_000);
  });
});
