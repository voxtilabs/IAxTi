import { describe, expect, it } from 'vitest';
import { diasDelReporte, fechaReporte, rangoReporte } from '../lib/reportes';

describe('serie de reportes (#424)', () => {
  it('conserva cada día y los ceros; no infla actividad ni desplaza las fechas', () => {
    expect(diasDelReporte([{ day: '2026-09-02', conversaciones: 0, resueltas: 3, oportunidades: 1 }], '2026-09-01', '2026-09-03')).toEqual([
      { day: '2026-09-01', conversaciones: 0, resueltas: 0, oportunidades: 0 },
      { day: '2026-09-02', conversaciones: 0, resueltas: 3, oportunidades: 1 },
      { day: '2026-09-03', conversaciones: 0, resueltas: 0, oportunidades: 0 },
    ]);
  });
  it('recorta al rango, ordena la serie y cruza meses y años', () => {
    const serie = diasDelReporte([{ day: '2026-01-02', conversaciones: 8, resueltas: 4, oportunidades: 1 }], '2025-12-31', '2026-01-01');
    expect(serie.map((d) => d.day)).toEqual(['2025-12-31', '2026-01-01']);
    expect(serie.every((d) => d.conversaciones === 0)).toBe(true);
  });
  for (const dias of [7, 30, 90]) it(`el rango ${dias} incluye exactamente esos días`, () => {
    const rango = rangoReporte(dias, new Date('2026-09-21T15:00:00Z'));
    expect(diasDelReporte([], rango.from, rango.to)).toHaveLength(dias);
    expect(rango.to).toBe('2026-09-21');
  });
  it('las etiquetas respetan el día, sin convertirlo a la noche anterior en Chile', () => {
    expect(fechaReporte('2026-09-21')).toContain('21');
  });
});
