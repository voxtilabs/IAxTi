import { describe, expect, it } from 'vitest';
import { techoDeEscala } from '../src/react/grafico-series';

describe('escala del gráfico (#424)', () => {
  it('muestra cero sin fabricar barras mínimas', () => {
    expect(techoDeEscala(0)).toBe(4);
  });
  it('la escala contiene el máximo y conserva marcas enteras legibles', () => {
    for (const max of [1, 3, 7, 13, 32, 98, 257, 12500]) {
      const techo = techoDeEscala(max);
      expect(techo).toBeGreaterThanOrEqual(max);
      expect(Number.isInteger(techo / 4)).toBe(true);
      expect(techo).toBeLessThanOrEqual(Math.max(4, max * 2.5));
    }
  });
});
