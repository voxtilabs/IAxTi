// Reglas puras de pipelines y oportunidades (SPEC §10). Sin base de datos:
// esto se prueba solo y la capa de aplicación lo usa antes de tocar tablas.

export type StageType = 'open' | 'won' | 'lost';

export interface StageInput {
  name: string;
  type: StageType;
  /** 0–100; opcional (forecast). */
  probability?: number;
  /** Días esperados en la etapa; pasado eso la oportunidad se marca estancada. */
  expectedDays?: number;
}

/** Un pipeline necesita camino abierto y ambos cierres para que Kanban y cierre funcionen. */
export function validateStages(stages: StageInput[]): void {
  if (stages.length < 3) {
    throw new Error('Un pipeline necesita al menos una etapa abierta, una ganada y una perdida.');
  }
  if (!stages.some((s) => s.type === 'open')) {
    throw new Error('Falta al menos una etapa abierta (open) donde trabajar las oportunidades.');
  }
  if (!stages.some((s) => s.type === 'won')) {
    throw new Error('Falta la etapa de cierre ganado (won).');
  }
  if (!stages.some((s) => s.type === 'lost')) {
    throw new Error('Falta la etapa de cierre perdido (lost).');
  }
  const nombres = new Set<string>();
  for (const s of stages) {
    if (!s.name.trim()) throw new Error('Toda etapa necesita nombre.');
    if (nombres.has(s.name)) throw new Error(`La etapa "${s.name}" está repetida.`);
    nombres.add(s.name);
    if (s.probability !== undefined && (s.probability < 0 || s.probability > 100)) {
      throw new Error(`La probabilidad de "${s.name}" debe estar entre 0 y 100.`);
    }
    if (s.expectedDays !== undefined && s.expectedDays < 0) {
      throw new Error(`Los días esperados de "${s.name}" no pueden ser negativos.`);
    }
  }
}

/**
 * Valor en pesos de una oportunidad (SPEC §10): en UF exige la UF del día y
 * congela el equivalente; en CLP es el mismo valor; en USD no se convierte.
 */
export function resolveValueClp(
  value: number | undefined,
  currency: 'CLP' | 'UF' | 'USD',
  ufRate?: number,
): { valueClp: number | null; ufRate: number | null } {
  if (value === undefined || value === null) return { valueClp: null, ufRate: null };
  if (currency === 'CLP') return { valueClp: value, ufRate: null };
  if (currency === 'USD') return { valueClp: null, ufRate: null };
  if (!ufRate || ufRate <= 0) {
    throw new Error('Para guardar un valor en UF necesitamos el valor de la UF del día.');
  }
  return { valueClp: Math.round(value * ufRate * 100) / 100, ufRate };
}
