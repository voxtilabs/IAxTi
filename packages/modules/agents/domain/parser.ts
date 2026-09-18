// El modelo devuelve JSON… casi siempre (#48). Parser defensivo: extrae el
// primer objeto, tolera fences, y ante basura cae a "todo es sugerencia".

export interface SuggestionPayload {
  sugerencia: string;
  confianza: number; // 0–1
  intencion: string | null;
  calificacion: 'frio' | 'tibio' | 'caliente' | null;
  crearOportunidad: boolean;
}

export function parseSuggestion(raw: string): SuggestionPayload {
  const fallback: SuggestionPayload = {
    sugerencia: raw.trim(),
    confianza: 0.5,
    intencion: null,
    calificacion: null,
    crearOportunidad: false,
  };
  const inicio = raw.indexOf('{');
  const fin = raw.lastIndexOf('}');
  // Un JSON que EMPIEZA y no cierra es una respuesta cortada, no un texto
  // suelto. Devolverla como `fallback` ponía esto en la bandeja, listo para
  // mandarle al cliente:
  //
  //     {"sugerencia": "¡Hola! Para darte el valor exacto y revisar
  //
  // Con los modelos que razonan pasa: los tokens de pensar salen del mismo
  // presupuesto, y una conversación larga se come el tope.
  if (inicio !== -1 && fin <= inicio) {
    return { ...fallback, sugerencia: '', confianza: 0 };
  }
  if (inicio === -1 || fin <= inicio) return fallback;
  try {
    const obj = JSON.parse(raw.slice(inicio, fin + 1)) as Record<string, unknown>;
    const sugerencia = typeof obj.sugerencia === 'string' ? obj.sugerencia.trim() : '';
    if (!sugerencia) return fallback;
    const conf = Number(obj.confianza);
    const calif = obj.calificacion;
    return {
      sugerencia,
      confianza: Number.isFinite(conf) ? Math.min(Math.max(conf, 0), 1) : 0.5,
      intencion: typeof obj.intencion === 'string' ? obj.intencion.slice(0, 40) : null,
      calificacion:
        calif === 'frio' || calif === 'tibio' || calif === 'caliente' ? calif : null,
      crearOportunidad: obj.crear_oportunidad === true || obj.crearOportunidad === true,
    };
  } catch {
    return fallback;
  }
}

/** El formato que se le PIDE al modelo (va en el prompt, no en el system). */
export const FORMATO_SUGERENCIA = `Responde SOLO este JSON:
{"sugerencia": "<respuesta lista para enviar al cliente>",
 "confianza": <0 a 1>,
 "intencion": "<cotizar|agendar|reclamo|consulta|otro>",
 "calificacion": "<frio|tibio|caliente>",
 "crear_oportunidad": <true si parece querer comprar o cotizar>}`;
