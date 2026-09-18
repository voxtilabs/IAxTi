// El objetivo final del agente (#315, SPEC §13).
//
// Un agente se configuraba con una caja de texto: personalidad, prompt y una
// lista de herramientas que el dueño tenía que curar a mano. Eso es pedirle a
// quien vende cortes de pelo que sea ingeniero de prompts.
//
// El objetivo amarra tres cosas que estaban sueltas: qué herramientas
// necesita, qué le decimos que tiene que lograr, y qué significa que lo
// logró. Puro: no toca base ni proveedores.

export const OBJETIVOS = ['agendar', 'vender', 'informar', 'calificar', 'cobrar'] as const;
export type Objetivo = (typeof OBJETIVOS)[number];

export interface DefinicionObjetivo {
  id: Objetivo;
  /** Cómo se lee en la pantalla de configuración. */
  titulo: string;
  /**
   * La instrucción que se le suma al prompt del agente. Se SUMA, no lo
   * reemplaza: el dueño que escribió el suyo no lo pierde.
   */
  instruccion: string;
  /**
   * Los módulos sin los cuales el objetivo no se puede cumplir. Si falta
   * alguno, el agente NO promete: lo dice y escala. La regla de negocio ya
   * lo exige —la IA nunca compromete lo que una tool no confirmó— y acá se
   * vuelve configuración en vez de un párrafo de prompt que hay que acordarse
   * de escribir.
   */
  requiere: readonly string[];
  /** Las tools que el objetivo pide. Se intersectan con las activas y las del agente. */
  tools: readonly string[];
  /**
   * El evento del catálogo que dice que se cumplió. `null` en los que no
   * dejan rastro propio: ahí el éxito es haber respondido sin escalar.
   *
   * Esto es lo que después permite decirle al dueño "de 100 conversaciones,
   * 34 terminaron en visita agendada" — que es lo único que le dice si el
   * agente sirve. Hoy solo medimos ejecuciones, tokens y costo, y nada de eso
   * responde esa pregunta.
   */
  eventoDeExito: readonly string[];
  /** Qué se le pide al cliente sí o sí para darlo por cumplido. */
  datosMinimos: readonly string[];
  /** Con qué palabra lo nombra el negocio, cuando no la configuró. */
  detallePorDefecto: string;
}

export const DEFINICIONES: Record<Objetivo, DefinicionObjetivo> = {
  agendar: {
    id: 'agendar',
    titulo: 'Agendar',
    // Una sola definición para reunión, visita, hora o consulta: mismas
    // herramientas, mismo evento de éxito, misma regla de escalamiento. Lo
    // único que cambia es la palabra, y esa va en `objetivoDetalle`.
    instruccion:
      'Tu objetivo es conseguir {detalle}. Ofrece horas CONCRETAS que hayas confirmado con la agenda, ' +
      'nunca inventes disponibilidad, y cierra confirmando día y hora. Si no puedes ver la agenda, dilo y pasa la conversación a una persona.',
    requiere: ['calendar'],
    tools: ['calendar.disponibilidad', 'calendar.agendar'],
    eventoDeExito: ['appointment.created'],
    datosMinimos: ['día y hora', 'nombre'],
    detallePorDefecto: 'una hora',
  },
  vender: {
    id: 'vender',
    titulo: 'Vender',
    instruccion:
      'Tu objetivo es llegar a {detalle}. Entiende qué necesita, dile solo lo que esté en el catálogo ' +
      'y lleva la conversación a una cotización concreta. Precio, stock y plazo SOLO los que confirmaste; ' +
      'si te falta uno, dilo y pasa la conversación a una persona.',
    requiere: ['crm'],
    tools: ['crm.buscar_contacto', 'knowledge.buscar', 'crm.crear_oportunidad'],
    eventoDeExito: ['deal.created', 'deal.stage_changed'],
    datosMinimos: ['qué quiere', 'cantidad o tamaño'],
    detallePorDefecto: 'una cotización',
  },
  informar: {
    id: 'informar',
    titulo: 'Entregar información',
    instruccion:
      'Tu objetivo es responder bien sobre {detalle}, con lo que está en el catálogo y nada más. ' +
      'Si la respuesta no está ahí, dilo derecho y pasa la conversación a una persona: inventar es peor que no saber.',
    requiere: ['knowledge'],
    tools: ['knowledge.buscar'],
    // No deja rastro propio: cumplió si respondió sin escalar.
    eventoDeExito: [],
    datosMinimos: [],
    detallePorDefecto: 'el negocio y lo que ofrece',
  },
  calificar: {
    id: 'calificar',
    titulo: 'Calificar el interesado',
    instruccion:
      'Tu objetivo es averiguar si {detalle} y dejar la conversación lista para una persona. ' +
      'Pregunta de a una cosa, no interrogues, y cuando tengas lo necesario pasa la conversación con lo que averiguaste.',
    requiere: ['crm'],
    tools: ['crm.buscar_contacto'],
    eventoDeExito: [],
    datosMinimos: ['qué necesita', 'para cuándo'],
    detallePorDefecto: 'esta persona necesita lo que vendemos',
  },
  cobrar: {
    id: 'cobrar',
    titulo: 'Cobrar',
    instruccion:
      'Tu objetivo es que quede pagado {detalle}. Manda el link de pago que generaste, nunca uno inventado, ' +
      'y confirma solo cuando el pago esté confirmado de verdad. Montos: los que confirmaste, jamás de memoria.',
    requiere: ['payments'],
    tools: ['payments.crear_link'],
    eventoDeExito: ['payment.confirmed'],
    datosMinimos: ['monto', 'qué se está pagando'],
    detallePorDefecto: 'lo acordado',
  },
};

export function esObjetivo(v: unknown): v is Objetivo {
  return typeof v === 'string' && (OBJETIVOS as readonly string[]).includes(v);
}

export interface ObjetivoResuelto {
  objetivo: Objetivo;
  definicion: DefinicionObjetivo;
  /** La instrucción con la palabra del negocio ya puesta. */
  instruccion: string;
  /** Los módulos que le faltan al tenant para poder cumplirlo. */
  faltan: string[];
  /** Puede cumplirlo: no le falta ningún módulo. */
  alcanzable: boolean;
  /** Las tools del objetivo que de verdad están disponibles. */
  tools: string[];
}

/**
 * El objetivo contra la realidad del tenant.
 *
 * Un objetivo que necesita un módulo apagado NO se calla: el agente tiene que
 * saber que no puede prometer eso. Degradar es decirlo y escalar — no seguir
 * como si nada, que es exactamente cómo la IA termina comprometiendo una hora
 * que nadie puede dar.
 */
export function resolverObjetivo(
  objetivo: Objetivo,
  detalle: string | null,
  modulosActivos: readonly string[],
): ObjetivoResuelto {
  const def = DEFINICIONES[objetivo];
  const activos = new Set(modulosActivos);
  const faltan = def.requiere.filter((m) => !activos.has(m));
  const palabra = detalle?.trim() || def.detallePorDefecto;
  return {
    objetivo,
    definicion: def,
    instruccion: def.instruccion.replace('{detalle}', palabra),
    faltan,
    alcanzable: faltan.length === 0,
    // Una tool cuyo módulo no está activa no se ofrece. El prefijo del
    // nombre es el módulo dueño: así no hay que mantener un mapa aparte que
    // se desincronice del catálogo de tools.
    tools: def.tools.filter((t) => activos.has(t.split('.')[0])),
  };
}

/**
 * El prompt del sistema con el objetivo adelante.
 *
 * El objetivo va PRIMERO y el prompt del agente después: lo que el agente
 * tiene que lograr manda sobre cómo lo dice. Y si no es alcanzable, la
 * advertencia va antes que todo — es lo único que evita que prometa.
 */
export function componerPrompt(
  base: string | null,
  resuelto: ObjetivoResuelto | null,
): string | null {
  if (!resuelto) return base;
  const partes = [resuelto.instruccion];
  if (!resuelto.alcanzable) {
    partes.push(
      `IMPORTANTE: ahora mismo NO tienes cómo cumplir esto (falta: ${resuelto.faltan.join(', ')}). ` +
        'No prometas ni des por hecho nada de eso. Explica que en un momento te ayuda una persona y pasa la conversación.',
    );
  }
  if (resuelto.definicion.datosMinimos.length > 0 && resuelto.alcanzable) {
    partes.push(`Antes de cerrar necesitas: ${resuelto.definicion.datosMinimos.join(', ')}.`);
  }
  if (base?.trim()) partes.push(base.trim());
  return partes.join('\n\n');
}
