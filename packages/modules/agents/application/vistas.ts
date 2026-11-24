/**
 * Las vistas del asistente (#1380): que la IA pueda acompañar su respuesta con
 * una tabla o unas cifras, dibujadas con componentes Mesón.
 *
 * La biblioteca es JSON Render (Vercel Labs, `@json-render/*`). Su modelo es
 * «la IA solo puede usar lo que TÚ registraste»: un catálogo cerrado donde cada
 * componente declara sus props con Zod. Eso, que en cualquier producto es una
 * comodidad, acá es LA frontera de seguridad:
 *
 * - **Presentacional y literal.** Los schemas solo aceptan strings, números,
 *   booleanos y arreglos planos. Una expresión (`{$state: ...}`, `$bindState`)
 *   es un objeto donde el schema pide un string: no se puede NI EXPRESAR. El
 *   spec del piloto no tiene `on`, `repeat` ni `visible` — las acciones siguen
 *   pasando por `Propuesta`, que ya va por permisos y audit.
 * - **Los datos salen de las tools.** La vista solo presenta lo que las
 *   herramientas devolvieron — que ya pasaron por el guard con la identidad de
 *   quien conversa. La IA arma el layout; jamás fabrica celdas. La regla del
 *   SPEC («la IA nunca inventa») queda intacta por construcción.
 * - **Cero viajes extra.** La vista viaja en la MISMA respuesta final, como un
 *   bloque ```vista al final del texto. Si no valida, se descarta y queda la
 *   prosa: un piloto roto no puede verse peor que lo que ya había.
 */
import { defineCatalog, defineSchema, validateSpec } from '@json-render/core';
import { z } from 'zod';

/**
 * El schema de UNA vista: árbol plano de elementos, sin nada dinámico.
 *
 * Es el de React de la biblioteca (`@json-render/react/schema`) repetido a
 * mano y a propósito, porque este módulo corre en el servidor y no debería
 * arrastrar a React solo para importar cuatro líneas de gramática. Lo que se
 * dejó afuera es la decisión: `slots`, `visible`, `repeat` no existen, y la
 * versión de la app que dibuja (`createRenderer`) los lee del spec, no del
 * schema — con que no estén, no hay nada que interpretar.
 */
const ESQUEMA = defineSchema((s) => ({
  spec: s.object({
    root: s.string(),
    elements: s.record(
      s.object({
        type: s.ref('catalog.components'),
        props: s.propsOf('catalog.components'),
        // Los que no tienen hijos pueden omitirlo. Sin spread de `s.optional()`
        // sería obligatorio y el modelo lo escribiría igual — pero vacío — en
        // cada hoja, pagando tokens por un campo que no dice nada.
        children: { ...s.array(s.string()), ...s.optional() },
      }),
    ),
  }),
  catalog: s.object({
    components: s.map({
      props: s.zod(),
      description: s.string(),
    }),
  }),
}));

/** El tono de una etiqueta. Los cuatro que la interfaz ya dibuja (ADR-0034). */
const TONO = z.enum(['neutral', 'good', 'warn', 'bad']);

/**
 * El catálogo del piloto: cinco componentes presentacionales, todos Mesón.
 *
 * La `description` de cada uno entra en la instrucción que se le da al modelo,
 * así que es para ÉL: cuándo usarlo, no cómo está implementado.
 */
export const CATALOGO_DE_VISTAS = defineCatalog(ESQUEMA, {
  components: {
    Zona: {
      props: z.object({ titulo: z.string().optional() }),
      description:
        'Agrupa lo que va junto, con un título corto opcional. Es el único componente que tiene hijos: las métricas de un mismo tema, o una tabla con su aclaración.',
    },
    Tabla: {
      props: z.object({
        titulo: z.string().optional(),
        columnas: z.array(z.string()).min(1).max(6),
        filas: z.array(z.array(z.string()).max(6)).max(50),
        /** Por columna: teléfono, monto, fecha u hora van en `true`. */
        mono: z.array(z.boolean()).optional(),
      }),
      description:
        'Una lista de filas: contactos, productos, horas. Máximo 6 columnas, cortas. En `mono` marca columna por columna las que son teléfono, monto o fecha.',
    },
    Metrica: {
      props: z.object({
        rotulo: z.string(),
        // Las herramientas devuelven cifras como número o como string ya
        // formateado; las dos son literales y las dos se dibujan tal cual.
        valor: z.union([z.string(), z.number()]),
        detalle: z.string().optional(),
      }),
      description:
        'Una cifra que importa, con su rótulo y una aclaración opcional. El valor va tal como lo devolvió la herramienta: jamás redondeado ni estimado.',
    },
    Tarjeta: {
      props: z.object({
        titulo: z.string(),
        texto: z.string(),
      }),
      description: 'Un dato puntual con título y texto: el resultado de una búsqueda.',
    },
    Etiqueta: {
      props: z.object({ texto: z.string(), tono: TONO }),
      description:
        'Una etiqueta corta de estado. `tono`: good para lo que anda, warn para lo que hay que mirar, bad para lo que no funciona, neutral para el resto.',
    },
  },
});

/** Una vista que ya pasó todas las validaciones. La forma en que viaja. */
export interface ElementoDeVista {
  type: string;
  props: Record<string, unknown>;
  children?: string[];
}
export interface Vista {
  root: string;
  elements: Record<string, ElementoDeVista>;
}

/** Techo del piloto: una vista es un apoyo, no un tablero. */
const MAX_ELEMENTOS = 24;
const MAX_TEXTO_EN_PROP = 240;
const MAX_BYTES_DEL_SPEC = 12_000;

/**
 * La instrucción que se le agrega al system prompt del Agente General.
 *
 * Vive junto al catálogo para que la deriva se VEA: el test de #1380 exige que
 * cada componente del catálogo aparezca acá, así que agregar un componente sin
 * contárselo al modelo deja la suite roja.
 */
export const INSTRUCCION_DE_VISTA = [
  'VISTAS (opcional): cuando tu respuesta se arma con datos que te devolvieron las herramientas —una lista o varias cifras— puedes dibujarla además de contarla. La vista va AL FINAL de tu respuesta, en un bloque:',
  '```vista',
  '{"root":"v1","elements":{"v1":{"type":"Tabla","props":{"columnas":["Contacto","Ventana"],"filas":[["María Paz","2 h"]],"mono":[false,true]}}}}',
  '```',
  'Reglas de la vista:',
  '- Solo con datos que una herramienta devolvió, tal cual. Si no tienes el dato, no va la fila ni la celda; la prosa dice lo que falte.',
  '- La prosa sigue siendo la respuesta. La vista la acompaña, no la reemplaza. Máximo 12 elementos, sin celdas de relleno.',
  `- Componentes: ${CATALOGO_DE_VISTAS.componentNames.join(', ')}. Sus props: ${[...Object.entries(
    CATALOGO_DE_VISTAS.data.components,
  )]
    .map(([nombre, def]) => `${nombre} ${nombreDeProps(def.props)}`)
    .join(' · ')}.`,
  '- Formato plano: {"root": id, "elements": {id: {type, props, children?}}}. Los ids los eliges tú. Solo Zona tiene hijos.',
  '- Nada más existe: ni botones, ni acciones, ni expresiones. Si la vista no alcanza para lo que quieres mostrar, responde solo en prosa.',
].join('\n');

/** El nombre de las props de un componente, para la línea de la instrucción. */
function nombreDeProps(schema: z.ZodType): string {
  const forma = (schema as unknown as { shape?: Record<string, unknown> }).shape;
  if (!forma) return 'sin props';
  return `{${Object.keys(forma).join(', ')}}`;
}

/**
 * Saca la vista del texto de la respuesta.
 *
 * Devuelve SIEMPRE el texto limpio —el bloque ```vista no se muestra, aunque
 * no valide— y la vista solo si pasó todo: el catálogo (props por componente),
 * la estructura (root que existe, hijos que apuntan) y los techos del piloto.
 */
export function extraerVista(texto: string): { texto: string; vista: Vista | null } {
  const bloques = [...texto.matchAll(/```vista[ \t]*\r?\n([\s\S]*?)```/g)];
  if (bloques.length === 0) return { texto, vista: null };

  // El último: la vista se pide al final, y si el modelo escribió dos, el que
  // cerró su respuesta es el que quiso mostrar.
  const ultimo = bloques[bloques.length - 1];
  const limpio = (texto.slice(0, ultimo.index) + texto.slice(ultimo.index! + ultimo[0].length))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();

  const vista = vistaValida(ultimo[1]);
  return { texto: limpio, vista };
}

/** Todo lo que tiene que pasar para que un spec del modelo se muestre. */
export function vistaValida(crudo: string): Vista | null {
  let parseado: unknown;
  try {
    parseado = JSON.parse(crudo);
  } catch {
    return null;
  }
  return vistaConfiable(parseado);
}

/**
 * Revalida una vista que ya viene como objeto — la que el hilo guardó en el
 * navegador y devuelve al dibujar la pantalla.
 *
 * El servidor ya validó antes de responder, pero el hilo vive en el
 * localStorage de quien usa la app: entre el servidor y el dibujo hay un dato
 * que cualquiera puede editar a mano, y las mismas reglas del catálogo se
 * corren ahí por si acaso (#1380). El resultado es la MISMA validación, no una
 * copia abreviada: los techos del piloto también valen del lado del cliente.
 */
export function vistaConfiable(vista: unknown): Vista | null {
  const porCatalogo = CATALOGO_DE_VISTAS.validate(vista);
  if (!porCatalogo.success || !porCatalogo.data) return null;

  const spec = porCatalogo.data as unknown as Vista;

  /**
   * Los props se validan CONTRA el Zod de SU componente, a mano y a propósito.
   *
   * El `validate` del catálogo no lo hace: su `propsOf` discrimina cuando el
   * catálogo tiene UN componente, y degrada a `Record<string, unknown>` cuando
   * tiene varios — que es el caso de cualquier catálogo de verdad. Sin esto,
   * un `valor: { $state: "/algo" }` pasaba como si nada: la promesa de
   * «presentacional y literal» se cumple acá y no en la biblioteca.
   */
  for (const elemento of Object.values(spec.elements)) {
    // `validate` ya aseguró que `type` es un nombre del catálogo; el índice va
    // por `Record` porque el tipo de transporte declara `string` a propósito
    // (la vista viaja como JSON, no como unión cerrada).
    const componentes = CATALOGO_DE_VISTAS.data.components as Record<
      string,
      { props: z.ZodType }
    >;
    const definicion = componentes[elemento.type];
    if (!definicion) return null;
    const props = definicion.props.safeParse(elemento.props);
    if (!props.success) return null;
    // Los datos que quedan son los que el schema conoce: lo que el modelo
    // escribió de más no se dibuja ni se guarda.
    elemento.props = props.data as Record<string, unknown>;
    for (const valor of Object.values(elemento.props)) {
      if (typeof valor === 'string' && valor.length > MAX_TEXTO_EN_PROP) return null;
    }
  }

  // Los techos del piloto: una vista es un apoyo, no un tablero entero.
  const ids = Object.keys(spec.elements);
  if (ids.length === 0 || ids.length > MAX_ELEMENTOS) return null;
  if (JSON.stringify(spec).length > MAX_BYTES_DEL_SPEC) return null;

  // Estructura: que el root exista y que cada hijo apunte a alguien.
  if (!validateSpec(spec as Parameters<typeof validateSpec>[0]).valid) return null;

  return spec;
}
