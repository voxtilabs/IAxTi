import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TASK_MODELS,
  RESPALDO_POR_PROVEEDOR,
  estimateCostUsd,
} from '../domain/config';

/**
 * Todo modelo que el producto puede elegir SOLO tiene que tener su precio.
 *
 * El mapa de precios ya lo advertía, con la cicatriz puesta: «sin su fila, el
 * costo sale null y el dueño ve consumo sin precio — y "costos visibles, sin
 * margen escondido" es una promesa del producto, no un detalle. Me pasó en la
 * primera corrida real: tokens registrados, cost_usd en null».
 *
 * Y volvió a pasar: al mover el proveedor por defecto a OpenAI (#863), ningún
 * modelo de OpenAI tenía fila. Lo cazó por rebote una prueba de runtime que
 * esperaba `costUsd > 0` — o sea, por suerte, y en el módulo equivocado.
 *
 * El aviso estaba escrito y no estaba aplicado. Esta es la guarda que faltaba:
 * no vigila una lista de nombres, vigila que todo camino que el producto puede
 * tomar tenga precio.
 */
describe('todo modelo elegible por el producto tiene precio', () => {
  const caminos = [
    ...Object.entries(DEFAULT_TASK_MODELS).map(([tarea, m]) => ({
      porque: `es el por defecto de "${tarea}"`,
      ...m,
    })),
    ...Object.entries(RESPALDO_POR_PROVEEDOR).flatMap(([provider, gama]) =>
      (['liviano', 'pesado'] as const).map((g) => ({
        porque: `es el respaldo ${g} de "${provider}"`,
        provider,
        model: gama[g],
      })),
    ),
  ];

  it('la guarda está mirando algo', () => {
    // Anti-vacuidad: si las dos fuentes quedaran vacías, el bucle de abajo
    // pasaría sin medir nada, que es exactamente el defecto que esto vigila.
    expect(caminos.length).toBeGreaterThan(10);
  });

  it.each(caminos)('$provider/$model tiene precio, porque $porque', ({ provider, model }) => {
    const costo = estimateCostUsd(provider, model, 1000, 1000);
    expect(
      costo,
      `No hay fila de precio para ${provider}:${model}. El producto puede elegirlo, así que ` +
        'el dueño vería tokens registrados y costo en blanco — y «costos visibles, en pesos, ' +
        'sin margen escondido» es una promesa escrita, no un detalle.',
    ).not.toBeNull();
    expect(costo).toBeGreaterThan(0);
  });
});
