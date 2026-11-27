import { z } from 'zod';
import { redactPII } from './config';

/**
 * Aprender de los chats del negocio (#1406, ADR-0039): lo que sale hacia el
 * proveedor de IA, decidido en UN lugar y sin base ni red.
 *
 * Las conversaciones son de los CLIENTES de la pyme. Este archivo es la
 * frontera: recibe los mensajes tal como los entrega el canal, y lo único que
 * deja salir es texto redactado, recortado y armado en un pedido que pide
 * preguntas frecuentes y tono, nunca datos de personas. Lo que vuelve también
 * se valida y se redacta otra vez antes de guardarse.
 *
 * Quién llama (el job de workers) no arma texto propio: si lo hiciera, la
 * redacción tendría una segunda copia, y la copia que se queda atrás es la que
 * deja pasar un teléfono.
 */

/** El alcance fijado por el ADR: los 50 chats más recientes, 30 mensajes cada uno. */
export const MAX_CHATS = 50;
export const MAX_MENSAJES_POR_CHAT = 30;
/** Un mensaje larguísimo no aporta más a una FAQ y sí más datos a redactar. */
const MAX_CARACTERES_POR_MENSAJE = 400;

export interface MensajeDeChat {
  /** Solo texto: adjuntos, audios y stickers no se leen. */
  texto: string | null | undefined;
  /** true si lo escribió el negocio; false si lo escribió el cliente. */
  delNegocio: boolean;
  /** ISO. Se usa para ordenar y para fechar un precio aprendido. */
  fecha: string;
}

export interface ChatParaAprender {
  /** Los grupos no se leen: el ADR los deja fuera. */
  esGrupo?: boolean;
  mensajes: MensajeDeChat[];
}

/**
 * La redacción de este camino: la de siempre (`redactPII`: teléfonos,
 * correos, RUT) más números de tarjeta y cualquier secuencia larga de dígitos
 * —cuentas bancarias, números de pedido que identifican a alguien—. Una regex
 * no ve todo (un nombre propio, una dirección escrita a mano): por eso lo
 * aprendido pasa por la revisión de la dueña antes de usarse (ADR-0039).
 */
export function redactarParaLaIA(texto: string): string {
  return redactPII(texto)
    // Teléfonos chilenos como los escribe la gente, con espacios, puntos o
    // guiones («9 8765 4321», «+56 2 2345 6789»): `redactPII` solo ve los
    // que vienen con +56 pegado o con los dígitos seguidos.
    .replace(/(?:\+?56[\s.-]?)?\b[29][\s.-]?\d{4}[\s.-]?\d{4}\b/g, '[teléfono]')
    // Internacionales con +, separados como sea.
    .replace(/\+\d[\d\s().-]{7,}\d/g, '[teléfono]')
    // Tarjetas: 13 a 19 dígitos, con o sin espacios o guiones.
    .replace(/\b(?:\d[ -]?){12,18}\d\b/g, '[número]')
    // Cuentas y otros identificadores: 8 o más dígitos seguidos que la
    // regla de teléfonos no tomó.
    .replace(/\b\d{8,}\b/g, '[número]')
    // Enlaces: pueden llevar tokens, nombres o direcciones en la ruta.
    .replace(/https?:\/\/\S+/g, '[enlace]');
}

/**
 * Las líneas que se van a leer, ya recortadas y redactadas.
 *
 * Toma los `MAX_CHATS` primeros (el llamador los entrega del más reciente al
 * más viejo), salta grupos, y de cada uno los últimos `MAX_MENSAJES_POR_CHAT`
 * mensajes con texto. Cada línea dice quién habló —«Cliente» o «Negocio»—,
 * nunca un nombre.
 */
export function chatsParaLeer(chats: ChatParaAprender[]): string[][] {
  return chats
    .filter((c) => !c.esGrupo)
    .slice(0, MAX_CHATS)
    .map((c) =>
      c.mensajes
        .filter((m) => typeof m.texto === 'string' && m.texto.trim() !== '')
        .sort((a, b) => a.fecha.localeCompare(b.fecha))
        .slice(-MAX_MENSAJES_POR_CHAT)
        .map((m) => {
          const texto = redactarParaLaIA(String(m.texto).replace(/\s+/g, ' ').trim()).slice(0, MAX_CARACTERES_POR_MENSAJE);
          return `${m.delNegocio ? 'Negocio' : 'Cliente'} (${m.fecha.slice(0, 10)}): ${texto}`;
        }),
    )
    .filter((lineas) => lineas.length > 0);
}

const SISTEMA = [
  'Lees conversaciones de WhatsApp de una pyme chilena con sus clientes para ayudar a su asistente',
  'a atender como el negocio atiende. Los datos personales ya vienen reemplazados por marcas como',
  '[teléfono], [correo] o [número].',
  '',
  'Devuelve SOLO un objeto JSON, sin texto alrededor, con esta forma:',
  '{"tono": "…", "entradas": [{"pregunta": "…", "respuesta": "…", "tipo": "precio|horario|servicio|despacho|pago|otro", "fecha": "AAAA-MM-DD"}]}',
  '',
  'Reglas:',
  '- "entradas": las preguntas que los clientes hacen MÁS de una vez, y cómo las responde el negocio,',
  '  con las palabras del negocio. Máximo 30. Una pregunta por entrada, escrita en general (no «¿me',
  '  guardas una hora el martes?» sino «¿Se puede reservar hora?»).',
  '- Solo lo que el NEGOCIO respondió de verdad en los chats. Si no hay respuesta del negocio, no hay entrada.',
  '  No completes, no deduzcas, no inventes precios, horarios ni condiciones.',
  '- "fecha": la del chat donde aparece la respuesta más reciente. Si la respuesta tiene un precio, el',
  '  tipo es "precio".',
  '- NUNCA incluyas nombres de personas, teléfonos, correos, direcciones, RUT, números de pedido ni',
  '  nada que identifique a un cliente. Si una respuesta solo tiene sentido con eso, no la incluyas.',
  '- "tono": una o dos frases sobre cómo le habla el negocio a sus clientes (tú o usted, cercano o',
  '  formal, emojis o no). Sin ejemplos con datos de clientes.',
].join('\n');

/** El pedido al proveedor. Lo único que sale: el sistema fijo y las líneas redactadas. */
export function pedidoDeAprendizaje(chats: string[][]): { system: string; prompt: string } {
  const prompt = chats
    .map((lineas, i) => `--- Chat ${i + 1} ---\n${lineas.join('\n')}`)
    .join('\n\n');
  return { system: SISTEMA, prompt };
}

const Entrada = z.object({
  pregunta: z.string().trim().min(3).max(300),
  respuesta: z.string().trim().min(1).max(800),
  tipo: z.enum(['precio', 'horario', 'servicio', 'despacho', 'pago', 'otro']).catch('otro'),
  fecha: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .catch(undefined),
});

export interface LoAprendido {
  tono: string | null;
  entradas: Array<{
    pregunta: string;
    respuesta: string;
    tipo: z.infer<typeof Entrada>['tipo'];
    fecha?: string;
    /** Lo que la pantalla de revisión muestra junto a un precio (ADR-0039). */
    aviso?: string;
  }>;
}

/**
 * Lee la respuesta del proveedor. Tolerante con la forma (un modelo puede
 * envolver el JSON en texto) y estricta con el contenido: cada campo se
 * vuelve a redactar —el modelo pudo copiar algo que la regex de entrada no
 * vio como dato, pero sí la de salida— y una entrada que no valida se
 * descarta en vez de romper todo lo demás.
 */
export function leerLoAprendido(texto: string): LoAprendido {
  const i = texto.indexOf('{');
  const f = texto.lastIndexOf('}');
  let crudo: unknown = null;
  if (i !== -1 && f > i) {
    try {
      crudo = JSON.parse(texto.slice(i, f + 1));
    } catch {
      crudo = null;
    }
  }
  const objeto = (crudo && typeof crudo === 'object' ? crudo : {}) as { tono?: unknown; entradas?: unknown };
  const tono = typeof objeto.tono === 'string' && objeto.tono.trim() ? redactarParaLaIA(objeto.tono.trim()).slice(0, 400) : null;
  const entradas: LoAprendido['entradas'] = [];
  for (const e of Array.isArray(objeto.entradas) ? objeto.entradas.slice(0, 30) : []) {
    const ok = Entrada.safeParse(e);
    if (!ok.success) continue;
    const { pregunta, respuesta, tipo, fecha } = ok.data;
    entradas.push({
      pregunta: redactarParaLaIA(pregunta),
      respuesta: redactarParaLaIA(respuesta),
      tipo,
      ...(fecha ? { fecha } : {}),
      // Un precio aprendido puede estar viejo, y la IA no inventa precio:
      // se marca para que la dueña lo confirme antes de aprobarlo.
      ...(tipo === 'precio'
        ? { aviso: `Precio visto en un chat${fecha ? ` del ${fecha.slice(8, 10)}-${fecha.slice(5, 7)}` : ''}; confírmalo antes de aprobar.` }
        : {}),
    });
  }
  return { tono, entradas };
}
