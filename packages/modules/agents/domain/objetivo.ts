// El objetivo final del agente (#315, SPEC §13).
//
// Un agente se configuraba con una caja de texto: personalidad, prompt y una
// lista de herramientas que el dueño tenía que curar a mano. Eso es pedirle a
// quien vende cortes de pelo que sea ingeniero de prompts.
//
// El objetivo amarra tres cosas que estaban sueltas: qué herramientas
// necesita, qué le decimos que tiene que lograr, y qué significa que lo
// logró. Puro: no toca base ni proveedores.

export const OBJETIVOS = [
  // Los que hablan con el CLIENTE del negocio, por WhatsApp.
  'agendar',
  'vender',
  'informar',
  'calificar',
  'cobrar',
  // Los que hablan con el DUEÑO, dentro del producto (#410).
  'estadisticas',
  'configuracion',
] as const;
export type Objetivo = (typeof OBJETIVOS)[number];

export interface DefinicionObjetivo {
  id: Objetivo;
  /** Cómo se lee en la pantalla de configuración. */
  titulo: string;
  /**
   * Con QUIÉN habla este asistente (#410).
   *
   * No es un objetivo más: es otro interlocutor. Los cinco primeros hablan
   * con el cliente del negocio por WhatsApp; los del dueño hablan con quien
   * lo administra, dentro del producto.
   *
   * Mezclarlos haría que el selector ofrezca "Vender" y "Estadísticas" como
   * si fueran comparables, y no lo son: cambian las herramientas, el tono,
   * lo que está permitido y hasta si hay una ventana de 24 horas.
   */
  destinatario: 'cliente' | 'dueño';
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
    destinatario: 'cliente',
    // Una sola definición para reunión, visita, hora o consulta: mismas
    // herramientas, mismo evento de éxito, misma regla de escalamiento. Lo
    // único que cambia es la palabra, y esa va en `objetivoDetalle`.
    //
    // La IA OFRECE, no toma la hora: `calendar.book` está cerrada por
    // ADR-0017 y la spec lo dice con todas sus letras (§16, "la IA ofrece
    // máximo tres horarios"). La primera versión de esta instrucción decía
    // "cierra confirmando día y hora" — le estaba pidiendo al modelo
    // exactamente lo que la arquitectura le prohíbe.
    instruccion:
      'Tu objetivo es dejar lista {detalle}. Ofrece COMO MÁXIMO tres horarios concretos que hayas ' +
      'confirmado con la agenda, nunca inventes disponibilidad, y cuando la persona elija uno pasa la ' +
      'conversación para que alguien lo confirme y lo tome. Tú no tomas la hora: la ofreces. ' +
      'Si no puedes ver la agenda, dilo y pasa la conversación a una persona.',
    requiere: ['calendar'],
    tools: ['calendar.get_slots', 'conversations.get_context'],
    eventoDeExito: ['appointment.created'],
    datosMinimos: ['el horario que prefiere', 'nombre'],
    detallePorDefecto: 'una hora',
  },
  vender: {
    id: 'vender',
    titulo: 'Vender',
    destinatario: 'cliente',
    instruccion:
      'Tu objetivo es llegar a {detalle}. Entiende qué necesita, dile solo lo que esté en el catálogo ' +
      'y lleva la conversación a una cotización concreta. Precio, stock y plazo SOLO los que confirmaste; ' +
      'si te falta uno, dilo y pasa la conversación a una persona.',
    requiere: ['crm'],
    tools: ['knowledge.search', 'knowledge.get_product', 'crm.create_deal', 'conversations.get_context'],
    eventoDeExito: ['deal.created', 'deal.stage_changed'],
    datosMinimos: ['qué quiere', 'cantidad o tamaño'],
    detallePorDefecto: 'una cotización',
  },
  informar: {
    id: 'informar',
    titulo: 'Entregar información',
    destinatario: 'cliente',
    instruccion:
      'Tu objetivo es responder bien sobre {detalle}, con lo que está en el catálogo y nada más. ' +
      'Si la respuesta no está ahí, dilo derecho y pasa la conversación a una persona: inventar es peor que no saber.',
    requiere: ['knowledge'],
    tools: ['knowledge.search', 'knowledge.get_product', 'conversations.get_context'],
    // No deja rastro propio: cumplió si respondió sin escalar.
    eventoDeExito: [],
    datosMinimos: [],
    detallePorDefecto: 'el negocio y lo que ofrece',
  },
  calificar: {
    id: 'calificar',
    titulo: 'Calificar el interesado',
    destinatario: 'cliente',
    instruccion:
      'Tu objetivo es averiguar si {detalle} y dejar la conversación lista para una persona. ' +
      'Pregunta de a una cosa, no interrogues, y cuando tengas lo necesario pasa la conversación con lo que averiguaste.',
    requiere: ['crm'],
    tools: ['conversations.get_context', 'knowledge.search', 'crm.create_activity'],
    eventoDeExito: [],
    datosMinimos: ['qué necesita', 'para cuándo'],
    detallePorDefecto: 'esta persona necesita lo que vendemos',
  },
  estadisticas: {
    id: 'estadisticas',
    titulo: 'Responder sobre los números',
    destinatario: 'dueño',
    // Nada de "cierra" ni "consigue": este no persigue nada, responde. Y la
    // instrucción más importante es la que le prohíbe rellenar — un modelo
    // al que le falta un dato lo estima, y un número estimado en un reporte
    // es peor que no tener reporte.
    instruccion:
      'Respondes preguntas sobre los números del negocio de quien te escribe, sobre todo {detalle}. ' +
      'Usa SIEMPRE las ' +
      'herramientas: nunca calcules de memoria ni estimes un valor que no te devolvieron. Si una ' +
      'métrica viene en cero, di que es cero; si viene sin datos, di que no hay datos en ese rango — ' +
      'no son lo mismo y confundirlos hace tomar malas decisiones. Di el rango de fechas que usaste ' +
      'en cada respuesta, y los montos en pesos. Si te preguntan algo que las herramientas no miden, ' +
      'dilo en vez de aproximarlo.',
    requiere: ['analytics'],
    tools: ['analytics.catalogo', 'analytics.metrica', 'analytics.comparar'],
    // No deja rastro propio: el éxito es haber respondido con datos reales.
    eventoDeExito: [],
    datosMinimos: [],
    detallePorDefecto: 'cómo va el negocio',
  },
  configuracion: {
    id: 'configuracion',
    titulo: 'Armar la configuración del negocio',
    destinatario: 'dueño',
    // El único que NO responde: propone. Su salida es un diff que el dueño
    // aplica o descarta (#50, ADR-0017), y por eso no tiene herramientas —
    // no le hace falta ninguna para proponer, y cualquiera que tuviera
    // sería una forma de aplicar sin que nadie haya dicho que sí.
    //
    // Lo que necesita saber —qué embudos y atajos ya existen— le llega en
    // el contexto de la propuesta. Una herramienta para leer lo mismo sería
    // un segundo camino al mismo dato, que es como se desincronizan.
    instruccion:
      'Propones cómo dejar configurado {detalle}: embudos con sus etapas, respuestas rápidas y ' +
      'plantillas de WhatsApp. Trabajas SOBRE lo que ya existe —si algo está, no lo repitas: ' +
      'mejóralo o deja lo que falta—. Nunca das por hecho que algo quedó aplicado: tú propones y ' +
      'una persona decide.',
    requiere: [],
    tools: [],
    eventoDeExito: [],
    datosMinimos: [],
    detallePorDefecto: 'tu negocio',
  },
  cobrar: {
    id: 'cobrar',
    titulo: 'Cobrar',
    destinatario: 'cliente',
    // Igual que agendar: la IA NO manda el link. `payments.create_link`
    // está cerrada por ADR-0017 — es plata saliendo hacia el cliente. El
    // agente deja todo listo y una persona lo manda.
    instruccion:
      'Tu objetivo es dejar listo el cobro de {detalle}. Confirma QUÉ se está pagando y por cuánto, ' +
      'usando solo montos que verificaste, jamás de memoria. Cuando esté claro, pasa la conversación para ' +
      'que una persona mande el link. Tú no mandas links de pago ni confirmas pagos.',
    requiere: ['payments'],
    tools: ['knowledge.get_product', 'conversations.get_context'],
    // `payment.received`, que es el evento que el módulo de pagos publica de
    // verdad al confirmar un pago (#544). Decía `payment.confirmed`, un nombre
    // que no existe en ningún manifiesto ni en ningún `publishEvent`: cada
    // intento de este objetivo terminaba en «perdido» al vencer la ventana, y
    // la tasa de logro decía 0 % para siempre.
    eventoDeExito: ['payment.received'],
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
  const alDueno = resuelto.definicion.destinatario === 'dueño';
  if (!resuelto.alcanzable) {
    // Al dueño no se le dice "en un momento te ayuda una persona": la
    // persona ES él. Se le dice qué le falta, que es lo accionable (#410).
    partes.push(
      alDueno
        ? `IMPORTANTE: ahora mismo NO tienes cómo responder esto: falta ${resuelto.faltan.join(', ')} ` +
          'en este negocio. Dilo con esas palabras en vez de aproximar una respuesta.'
        : `IMPORTANTE: ahora mismo NO tienes cómo cumplir esto (falta: ${resuelto.faltan.join(', ')}). ` +
          'No prometas ni des por hecho nada de eso. Explica que en un momento te ayuda una persona y pasa la conversación.',
    );
  }
  if (resuelto.definicion.datosMinimos.length > 0 && resuelto.alcanzable) {
    partes.push(`Antes de cerrar necesitas: ${resuelto.definicion.datosMinimos.join(', ')}.`);
  }
  if (base?.trim()) partes.push(base.trim());
  return partes.join('\n\n');
}
