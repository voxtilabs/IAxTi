import { describe, expect, it } from 'vitest';
import { ejecutarHerramienta } from '../application/herramientas';

/**
 * Las herramientas de números, por el mismo guard que el resto (#410).
 *
 * Lo que importa acá no es que devuelvan datos —eso lo prueba analytics—
 * sino que no puedan usarse mal: sin permiso, con fechas inventadas, o con
 * el módulo apagado.
 */
const TRES = ['analytics.metrica', 'analytics.comparar', 'analytics.catalogo'];

const deps = (extra: Record<string, unknown> = {}) => ({
  actorPuede: async () => true,
  habilitadas: TRES,
  getContext: async () => ({}),
  buscarConocimiento: async () => [],
  buscarProducto: async () => [],
  catalogoDeMetricas: async () => [{ metrica: 'ganadas', definicion: 'x', unidad: 'cantidad' }],
  metricaDelNegocio: async (i: { metrica: string; desde: string; hasta: string }) => ({
    metrica: i.metrica, valor: i.desde === '2026-08-01' ? 10 : 15, definicion: 'x',
    desde: i.desde, hasta: i.hasta, unidad: 'cantidad', sinDatos: false,
  }),
  ...extra,
});

const base = { tenantId: 't', actorUserId: 'u', args: {} as Record<string, unknown> };
const correr = (tool: string, args: Record<string, unknown>, d = deps()) =>
  ejecutarHerramienta(null as never, { ...base, tool, args }, d as never);

describe('las herramientas de números', () => {
  it('sin el permiso de la persona no se ejecutan', async () => {
    const r = await correr('analytics.metrica',
      { metrica: 'ganadas', desde: '2026-09-01', hasta: '2026-09-30' },
      deps({ actorPuede: async () => false }));
    expect(r.ok).toBe(false);
    // "La IA no puede hacer lo que la persona no podría."
    expect(r.error).toContain('analytics.read');
  });

  it('con analytics apagado dicen la verdad, no fallan raro', async () => {
    const r = await correr('analytics.metrica',
      { metrica: 'ganadas', desde: '2026-09-01', hasta: '2026-09-30' },
      deps({ metricaDelNegocio: undefined }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no están disponibles/);
  });

  it('una fecha inventada falla con un motivo que el modelo puede corregir', async () => {
    // Un modelo escribe "2026-13-45" sin pestañear. Postgres lo rechazaría
    // con un error que no le dice nada a nadie.
    for (const mala of ['2026-13-45', 'ayer', '01/09/2026', '']) {
      const r = await correr('analytics.metrica', { metrica: 'ganadas', desde: mala, hasta: '2026-09-30' });
      expect(r.ok, `desde="${mala}"`).toBe(false);
      expect(r.error).toMatch(/AAAA-MM-DD|no es una fecha/);
    }
  });

  it('el rango al revés se avisa en vez de devolver cero', async () => {
    // Devolver cero sería peor: el dueño leería "no vendiste nada".
    const r = await correr('analytics.metrica',
      { metrica: 'ganadas', desde: '2026-09-30', hasta: '2026-09-01' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/al revés/);
  });

  it('comparar calcula la variación acá, no en el modelo', async () => {
    // Un LLM haciendo aritmética sobre plata es justo lo que no queremos.
    const r = await correr('analytics.comparar', {
      metrica: 'ganadas',
      desdeA: '2026-08-01', hastaA: '2026-08-31',
      desdeB: '2026-09-01', hastaB: '2026-09-30',
    });
    expect(r.ok).toBe(true);
    const d = r.datos as { variacion: { absoluta: number; porcentual: number | null } };
    expect(d.variacion.absoluta).toBe(5);
    expect(d.variacion.porcentual).toBe(50);
  });

  it('sin base no inventa un porcentaje', async () => {
    // "Subió infinito" no le sirve a nadie.
    const r = await correr('analytics.comparar', {
      metrica: 'ganadas',
      desdeA: '2026-08-01', hastaA: '2026-08-31',
      desdeB: '2026-09-01', hastaB: '2026-09-30',
    }, deps({
      metricaDelNegocio: async (i: { desde: string }) => ({
        valor: i.desde === '2026-08-01' ? 0 : 7, metrica: 'ganadas', definicion: 'x',
        desde: i.desde, hasta: 'x', unidad: 'cantidad', sinDatos: false,
      }),
    }));
    const d = r.datos as { variacion: { absoluta: number; porcentual: number | null } };
    expect(d.variacion.absoluta).toBe(7);
    expect(d.variacion.porcentual).toBeNull();
  });

  it('ninguna de las tres escribe', async () => {
    for (const t of TRES) {
      const r = await correr(t, { metrica: 'ganadas', desde: '2026-09-01', hasta: '2026-09-30',
        desdeA: '2026-09-01', hastaA: '2026-09-30', desdeB: '2026-09-01', hastaB: '2026-09-30' });
      expect(r.ok, t).toBe(true);
    }
  });
});
