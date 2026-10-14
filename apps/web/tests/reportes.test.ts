import { describe, expect, it } from 'vitest';
import { compararCifras, diasDelReporte, fechaReporte, rangoReporte } from '../lib/reportes';

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

/**
 * La comparación con el período anterior (#588, punto 5).
 *
 * Lo que se prueba no es el porcentaje —ese es una división— sino los cuatro
 * casos donde una tarjeta puede mentir con cara de dato.
 */
describe('comparar contra el período anterior (#588)', () => {
  const rango = '1 sept – 7 sept';
  const base = { comparable: true, rango };

  it('dice el porcentaje, la dirección en palabras y contra qué compara', () => {
    const c = compararCifras(142, 120, base);
    expect(c.texto).toBe('18 % más que 1 sept – 7 sept');
    expect(c.tono).toBe('good');
    expect(c.sube).toBe(true);
  });

  it('NO inventa un porcentaje cuando el negocio no existía antes', () => {
    const c = compararCifras(142, 0, { ...base, comparable: false });
    expect(c.texto).toBe('sin período anterior para comparar');
    expect(c.tono).toBeNull();
    // Sin flecha: no subió ni bajó, no había de dónde.
    expect(c.sube).toBeNull();
    expect(c.texto).not.toContain('%');
  });

  it('no divide por cero: un cero anterior se dice en números, no en por ciento', () => {
    const c = compararCifras(5, 0, base);
    expect(c.texto).toBe('antes 0, en 1 sept – 7 sept');
    expect(c.texto).not.toContain('%');
    expect(c.texto).not.toContain('Infinity');
    // Sigue siendo una buena noticia, y se pinta como tal.
    expect(c.tono).toBe('good');
  });

  it('un null es «no se midió» y no un cero', () => {
    expect(compararCifras(45, null, base).texto).toBe('sin medir en 1 sept – 7 sept');
    expect(compararCifras(null, 45, base).texto).toBe('sin medir en 1 sept – 7 sept');
  });

  it('subir es malo cuando la métrica mide demora', () => {
    // 45 s contra 30 s: la atención se puso más lenta.
    const peor = compararCifras(45, 30, { ...base, mejorEsMenos: true });
    expect(peor.tono).toBe('bad');
    expect(peor.texto).toBe('50 % más que 1 sept – 7 sept');
    // Y bajar, al revés.
    expect(compararCifras(30, 45, { ...base, mejorEsMenos: true }).tono).toBe('good');
    // La misma subida en conversaciones es buena noticia.
    expect(compararCifras(45, 30, base).tono).toBe('good');
  });

  it('distingue «igual» de «se movió poco»', () => {
    expect(compararCifras(120, 120, base).texto).toBe('igual que 1 sept – 7 sept');
    expect(compararCifras(120, 120, base).tono).toBeNull();
    // 1004 contra 1000 redondea a 0 %: decir «0 % más» es ruido.
    const casi = compararCifras(1004, 1000, base);
    expect(casi.texto).toBe('casi igual que 1 sept – 7 sept');
    expect(casi.tono).toBeNull();
  });

  it('baja con porcentaje y en palabras, para que el color no sea el único aviso', () => {
    const c = compararCifras(90, 120, base);
    expect(c.texto).toBe('25 % menos que 1 sept – 7 sept');
    expect(c.tono).toBe('bad');
    expect(c.sube).toBe(false);
  });
});
