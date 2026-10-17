// El modelo devuelve JSON… casi siempre (#48). Parser defensivo: extrae el
// primer objeto, tolera fences, y ante basura cae a "todo es sugerencia".

/**
 * La acción que el asistente propone junto a su respuesta (#1000).
 *
 * `herramienta` es un nombre del catálogo del Agente General. Acá solo se
 * valida la FORMA —que haya nombre y que los argumentos sean un objeto—;
 * que la herramienta exista, que su módulo esté activo y que la persona tenga
 * el permiso se revalida al APLICAR, no al guardar. Entre que el asistente
 * propone y el dueño aprieta pueden pasar quince minutos y cambiar las tres
 * cosas.
 *
 * Este parser vive en `domain/` y el catálogo en `application/`: mirarlo desde
 * acá invertiría la dependencia. Por eso la lista blanca de qué se puede
 * proponer está del otro lado, donde se guarda.
 */
export interface AccionPropuesta {
  herramienta: string;
  argumentos: Record<string, unknown>;
}

export interface SuggestionPayload {
  sugerencia: string;
  confianza: number; // 0–1
  intencion: string | null;
  calificacion: 'frio' | 'tibio' | 'caliente' | null;
  crearOportunidad: boolean;
  /** `null` cuando no propone nada, que es el caso normal. */
  accion: AccionPropuesta | null;
}

/**
 * La forma de la acción, o nada.
 *
 * Tolerante igual que el resto del parser: un modelo que manda la acción a
 * medias —sin nombre, o con los argumentos como string— no tiene que tumbar la
 * sugerencia. Se pierde la acción y queda el texto, que es lo que de verdad
 * necesita quien atiende.
 */
function accionDe(crudo: unknown): AccionPropuesta | null {
  if (crudo === null || typeof crudo !== 'object' || Array.isArray(crudo)) return null;
  const o = crudo as Record<string, unknown>;
  const herramienta = typeof o.herramienta === 'string' ? o.herramienta.trim() : '';
  if (!herramienta) return null;
  const args = o.argumentos;
  // Un objeto o nada: hay acciones sin argumentos (confirmar una cita) y el
  // `{}` es legítimo. Un arreglo o un string no lo son.
  if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
    return null;
  }
  return { herramienta, argumentos: (args as Record<string, unknown>) ?? {} };
}

export function parseSuggestion(raw: string): SuggestionPayload {
  const fallback: SuggestionPayload = {
    sugerencia: raw.trim(),
    confianza: 0.5,
    intencion: null,
    calificacion: null,
    crearOportunidad: false,
    accion: null,
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
      accion: accionDe(obj.accion),
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
 "crear_oportunidad": <true si parece querer comprar o cotizar>,
 "accion": <null, o {"herramienta": "<una de las que te pasaron>", "argumentos": {…}} si
            para ayudarle hace falta HACER algo y no solo responder>}

Sobre "accion": no la ejecutas vos. Queda esperando el visto bueno de quien
atiende, que la ve con sus datos y aprieta una vez. Así que propónela cuando el
cliente pidió algo concreto —agendar, mover una hora, un link de pago— y tu
respuesta ya se lo dice; nunca "ya te lo agendé", sino "te lo dejo listo para
confirmar".`;
