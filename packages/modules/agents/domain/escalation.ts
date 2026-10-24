// Escalamiento (#49, SPEC §13): detectores DETERMINISTAS que mandan sobre
// el modelo — si el cliente pide persona o hay enojo/amenaza legal, la IA
// no responde: escala. El modelo además puede declarar "escalar" él mismo.

export type EscalationReason =
  | 'pide_humano'
  | 'enojo_o_legal'
  | 'fuera_de_conocimiento'
  | 'sin_avance'
  | 'confianza_baja'
  | 'monto_alto'
  | 'error_del_modelo'
  /** El modelo se quedó sin espacio de salida: no falló, no le alcanzó. */
  | 'respuesta_cortada'
  /** La «respuesta» es el bloque de conocimiento pegado: eso no viaja (#1021). */
  | 'eco_del_contexto';

const PIDE_HUMANO =
  /\b(humano|persona\s+real|hablar\s+con\s+(?:alguien|una?\s+person\w*|un\s+ejecutiv\w*)|ejecutiv[oa]|operador\w*|no\s+quiero\s+(?:un\s+)?(?:bot|robot))\b/i;

const ENOJO_LEGAL =
  /\b(reclamo|demanda(?:r)?|abogad[oa]|sernac|estafa|robo|denuncia(?:r)?|indignad|p[eé]sim[oa]|vergüenza|inaceptable)\b/i;

/** Los detectores locales: baratos, deterministas y previos a gastar. */
export function detectEscalation(texto: string | null | undefined): EscalationReason | null {
  if (!texto) return null;
  if (PIDE_HUMANO.test(texto)) return 'pide_humano';
  if (ENOJO_LEGAL.test(texto)) return 'enojo_o_legal';
  return null;
}

/**
 * La respuesta que es el contexto pegado, no una respuesta (#1021).
 *
 * Medido el 24/10: gpt-5-mini puso en `respuesta` el bloque de conocimiento
 * COMPLETO, con el marcador interno «— [nombre de la fuente]» a la vista del
 * cliente y datos que nadie preguntó. El prompt ya lo prohíbe (#1031), pero
 * es estocástico — y lo que PUEDE salir mal delante de un cliente necesita
 * un cinturón que no dependa del humor del modelo.
 *
 * Dos detectores, los dos deterministas:
 * 1. El marcador «— [» del formato interno de citas: ese texto no existe en
 *    ninguna respuesta legítima — las citas buenas dicen «(según X)».
 * 2. Un tramo largo del conocimiento copiado LITERAL (80+ caracteres tras
 *    normalizar espacios): aunque el modelo le quite el marcador, un volcado
 *    sigue siendo un volcado.
 *
 * Se compara contra el BLOQUE DE CONOCIMIENTO, no contra el contexto entero:
 * los últimos mensajes también van en el contexto, y repetir lo que el
 * cliente dijo («confirmo: corte más barba el sábado») es conversación
 * normal, no eco.
 */
export function esEcoDelContexto(respuesta: string, conocimiento: string | null | undefined): boolean {
  if (respuesta.includes('— [')) return true;
  if (!conocimiento) return false;
  const plano = (t: string): string => t.replace(/\s+/g, ' ').trim();
  const r = plano(respuesta);
  const k = plano(conocimiento);
  const TRAMO = 80;
  if (r.length < TRAMO || k.length < TRAMO) return false;
  // Ventanas solapadas: un tramo copiado de 120 caracteres siempre contiene
  // una ventana alineada a la mitad del paso.
  for (let i = 0; i + TRAMO <= r.length; i += TRAMO / 2) {
    if (k.includes(r.slice(i, i + TRAMO))) return true;
  }
  return k.includes(r.slice(r.length - TRAMO));
}

/** Lo que se le pide al modelo en modo autónomo: respuesta O escalar. */
export function formatoAutonomo(opts: { moneyLimitClp: number | null }): string {
  const dinero = opts.moneyLimitClp
    ? `- Cualquier cosa que involucre dinero sobre $${opts.moneyLimitClp.toLocaleString('es-CL')} CLP: escalar.`
    : '- Cualquier compromiso de dinero que no esté confirmado en el contexto: escalar.';
  return `REGLAS NO NEGOCIABLES (si alguna aplica, responde con "escalar": true y NO respondas al cliente):
- NUNCA inventes precio, stock, plazo ni descuento. Si el dato no está en el contexto: escalar con motivo "fuera_de_conocimiento".
- NUNCA afirmes algo que una herramienta no confirmó.
- NUNCA uses datos de otro cliente o negocio.
${dinero}
- Si el cliente pide hablar con una persona, está enojado, reclama o amenaza con acciones legales: escalar.

"escalar" habla de lo que el cliente PREGUNTÓ, no de tu objetivo: si lo
preguntado está respondido por el contexto, respóndelo — en tus palabras y solo
eso, sin volcar el contexto entero. Que tú no puedas agendar, cobrar ni
confirmar una hora NO es "fuera_de_conocimiento": responde lo preguntado sin
prometer esa gestión ni ofrecer gestiones que nadie pidió.

Responde SOLO este JSON:
{"respuesta": "<respuesta breve y cordial lista para enviar>",
 "confianza": <0 a 1>,
 "intencion": "<cotizar|agendar|reclamo|consulta|otro>",
 "calificacion": "<frio|tibio|caliente>",
 "escalar": <true|false>,
 "motivo_escalar": "<fuera_de_conocimiento|pide_humano|enojo_o_legal|monto_alto|otro|null>"}`;
}

export interface AutonomousPayload {
  respuesta: string;
  confianza: number;
  intencion: string | null;
  calificacion: 'frio' | 'tibio' | 'caliente' | null;
  escalar: boolean;
  motivoEscalar: string | null;
}

/**
 * Parser del modo autónomo: acá NO hay fallback "todo es respuesta" — un
 * texto que no parsea JAMÁS viaja al cliente. Ante basura: escalar.
 */
export function parseAutonomous(raw: string): AutonomousPayload {
  const escalado: AutonomousPayload = {
    respuesta: '',
    confianza: 0,
    intencion: null,
    calificacion: null,
    escalar: true,
    motivoEscalar: 'error_del_modelo',
  };
  const inicio = raw.indexOf('{');
  const fin = raw.lastIndexOf('}');
  if (inicio === -1 || fin <= inicio) return escalado;
  try {
    const obj = JSON.parse(raw.slice(inicio, fin + 1)) as Record<string, unknown>;
    const respuesta = typeof obj.respuesta === 'string' ? obj.respuesta.trim() : '';
    const conf = Number(obj.confianza);
    const calif = obj.calificacion;
    if (obj.escalar === true || !respuesta) {
      return {
        ...escalado,
        motivoEscalar:
          typeof obj.motivo_escalar === 'string' ? obj.motivo_escalar.slice(0, 40) : 'otro',
      };
    }
    return {
      respuesta,
      confianza: Number.isFinite(conf) ? Math.min(Math.max(conf, 0), 1) : 0,
      intencion: typeof obj.intencion === 'string' ? obj.intencion.slice(0, 40) : null,
      calificacion:
        calif === 'frio' || calif === 'tibio' || calif === 'caliente' ? calif : null,
      escalar: false,
      motivoEscalar: null,
    };
  } catch {
    return escalado;
  }
}
