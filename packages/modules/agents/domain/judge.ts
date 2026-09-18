// LLM-as-judge (#53): rúbrica fija — correctness, tono y selección de
// tool — con nota 0 a 1 por dimensión. El juez recibe los CRITERIOS del
// caso: evalúa contra lo esperado, no contra su gusto.

export interface JudgeScores {
  correctness: number;
  tono: number;
  tools: number;
  total: number;
  comentario: string | null;
  /**
   * Si la nota se pudo LEER. Falso no es un cero: es que no hay dato.
   *
   * Un juez cortado a la mitad devuelve `{"correctness": 0.8` y eso no
   * parsea. Contarlo como 0 mezcla "respondió pésimo" con "no se pudo
   * medir", y las dos cosas se arreglan distinto. Peor: el promedio queda
   * mentirosamente bajo, y de ese promedio depende el gate.
   */
  medible: boolean;
}

export function formatoJuez(input: {
  contexto: string;
  criterios: string[];
  respuesta: string;
}): string {
  return `Eres el evaluador de un asistente de ventas por WhatsApp de una pyme chilena.

CONTEXTO QUE VIO EL ASISTENTE:
${input.contexto}

LO QUE SE ESPERABA (criterios del caso):
${input.criterios.map((c) => `- ${c}`).join('\n')}

RESPUESTA DEL ASISTENTE A EVALUAR:
${input.respuesta}

Califica de 0.0 a 1.0 cada dimensión:
- correctness: ¿cumple los criterios? ¿No inventa datos (precios, stock, plazos, servicios)?
- tono: ¿cercano, chileno, profesional, sin sonar robot ni gerente de banco?
- tools: ¿usó/citó el conocimiento disponible cuando existía, y no afirmó nada sin respaldo?

Responde SOLO este JSON:
{"correctness": <0-1>, "tono": <0-1>, "tools": <0-1>, "comentario": "<una frase con lo peor y lo mejor>"}`;
}

/** Parser defensivo del juez: si no se puede leer, NO es un cero — es que no hay nota. */
export function parseJudge(raw: string): JudgeScores {
  const sinNota: JudgeScores = {
    correctness: 0,
    tono: 0,
    tools: 0,
    total: 0,
    comentario: 'El juez no respondió legible.',
    medible: false,
  };
  const inicio = raw.indexOf('{');
  const fin = raw.lastIndexOf('}');
  if (inicio === -1 || fin <= inicio) return sinNota;
  try {
    const obj = JSON.parse(raw.slice(inicio, fin + 1)) as Record<string, unknown>;
    const nota = (v: unknown) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(Math.max(n, 0), 1) : 0;
    };
    const correctness = nota(obj.correctness);
    const tono = nota(obj.tono);
    const tools = nota(obj.tools);
    return {
      correctness,
      tono,
      tools,
      // Correctness pesa doble: inventar un precio es peor que sonar tieso.
      total: Math.round(((correctness * 2 + tono + tools) / 4) * 1000) / 1000,
      comentario: typeof obj.comentario === 'string' ? obj.comentario.slice(0, 300) : null,
      medible: true,
    };
  } catch {
    return sinNota;
  }
}

export interface EvalCase {
  id: string;
  contexto: string;
  criterios: string[];
}
