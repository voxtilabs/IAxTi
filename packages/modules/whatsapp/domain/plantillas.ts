/**
 * Plantillas de WhatsApp (#44, SPEC §12).
 *
 * Fuera de la ventana de 24 h no se puede escribir texto libre: Meta solo
 * deja salir una plantilla aprobada por ellos. Sin esto, una conversación
 * que se enfrió no se retoma nunca — y con eso se cae también el envío
 * segmentado a la cartera (#75), que por definición sale fuera de ventana.
 *
 * Esto es dominio puro: las reglas de forma que Meta aplica al aprobar. Se
 * validan ACÁ y no al recibir el rechazo, porque un rechazo tarda horas y
 * llega sin decir cuál de las reglas se rompió.
 */

export const CATEGORIAS = ['marketing', 'utility', 'authentication'] as const;
export type CategoriaPlantilla = (typeof CATEGORIAS)[number];

/**
 * El estado lo manda Meta, no nosotros. `paused` y `disabled` existen
 * porque una plantilla aprobada se puede caer sola si la gente la reporta:
 * la calidad de la plantilla es aparte de la calidad del número.
 */
export const ESTADOS_PLANTILLA = [
  'draft',
  'pending',
  'approved',
  'rejected',
  'paused',
  'disabled',
] as const;
export type EstadoPlantilla = (typeof ESTADOS_PLANTILLA)[number];

const TRANSICIONES: Record<EstadoPlantilla, EstadoPlantilla[]> = {
  draft: ['pending'],
  pending: ['approved', 'rejected'],
  // Rechazada se corrige y se vuelve a mandar.
  rejected: ['draft', 'pending'],
  approved: ['paused', 'disabled'],
  paused: ['approved', 'disabled'],
  disabled: [],
};

export function assertTransicionPlantilla(from: EstadoPlantilla, to: EstadoPlantilla): void {
  if (!TRANSICIONES[from]?.includes(to)) {
    throw new Error(`Transición de plantilla inválida: ${from} → ${to}`);
  }
}

/** Solo una plantilla aprobada puede salir. Las otras no existen para Meta. */
export function puedeEnviarse(estado: EstadoPlantilla): boolean {
  return estado === 'approved';
}

export interface PlantillaBorrador {
  name: string;
  language: string;
  category: CategoriaPlantilla;
  header?: string;
  body: string;
  footer?: string;
  buttons?: string[];
}

const LIMITES = {
  nombre: 512,
  header: 60,
  body: 1024,
  footer: 60,
  boton: 25,
  botones: 3,
};

/**
 * El nombre viaja a Meta como identificador: minúsculas, números y guion
 * bajo. Uno con mayúsculas o espacios lo rechazan sin decir por qué.
 */
export function normalizarNombre(nombre: string): string {
  const limpio = (nombre ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!limpio) throw new Error('La plantilla necesita un nombre.');
  if (limpio.length > LIMITES.nombre) throw new Error('El nombre de la plantilla es muy largo.');
  return limpio;
}

/** Las variables que usa un texto, en el orden en que aparecen. */
export function variablesDe(texto: string): number[] {
  return [...(texto ?? '').matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
}

/**
 * Valida la forma contra las reglas de Meta. Cada mensaje dice qué hacer y
 * no solo qué está mal: quien escribe una plantilla no tiene por qué
 * conocer las reglas de una API.
 */
export function validarPlantilla(p: PlantillaBorrador): void {
  if (!(CATEGORIAS as readonly string[]).includes(p.category)) {
    throw new Error(`Categoría desconocida: ${p.category}. Usa marketing, utility o authentication.`);
  }
  if (!/^[a-z]{2}(_[A-Z]{2})?$/.test(p.language ?? '')) {
    throw new Error('El idioma va como "es" o "es_CL".');
  }

  const body = (p.body ?? '').trim();
  if (!body) throw new Error('La plantilla necesita un cuerpo.');
  if (body.length > LIMITES.body) {
    throw new Error(`El cuerpo no puede pasar de ${LIMITES.body} caracteres.`);
  }

  const vars = variablesDe(body);
  // Numeradas desde 1 y sin saltos: Meta rechaza {{1}} {{3}} sin explicar.
  const esperadas = vars.map((_, i) => i + 1);
  if (vars.some((v, i) => v !== esperadas[i])) {
    throw new Error('Las variables van numeradas desde {{1}} y sin saltos: {{1}}, {{2}}, {{3}}…');
  }
  if (/\{\{\s*\d+\s*\}\}\s*\{\{\s*\d+\s*\}\}/.test(body)) {
    throw new Error('Dos variables seguidas no se aprueban: escribe algo entre ellas.');
  }
  if (/^\{\{\s*\d+\s*\}\}/.test(body) || /\{\{\s*\d+\s*\}\}$/.test(body)) {
    throw new Error('El cuerpo no puede empezar ni terminar con una variable.');
  }

  if (p.header !== undefined) {
    const header = p.header.trim();
    if (header.length > LIMITES.header) {
      throw new Error(`El encabezado no puede pasar de ${LIMITES.header} caracteres.`);
    }
    if (/\n/.test(header)) throw new Error('El encabezado va en una sola línea.');
    if (variablesDe(header).length > 1) {
      throw new Error('El encabezado admite una sola variable.');
    }
  }

  if (p.footer !== undefined) {
    const footer = p.footer.trim();
    if (footer.length > LIMITES.footer) {
      throw new Error(`El pie no puede pasar de ${LIMITES.footer} caracteres.`);
    }
    if (variablesDe(footer).length > 0) {
      throw new Error('El pie no admite variables.');
    }
  }

  if (p.buttons) {
    if (p.buttons.length > LIMITES.botones) {
      throw new Error(`Máximo ${LIMITES.botones} botones.`);
    }
    for (const boton of p.buttons) {
      if (!boton.trim()) throw new Error('Un botón sin texto no se aprueba.');
      if (boton.length > LIMITES.boton) {
        throw new Error(`Cada botón admite ${LIMITES.boton} caracteres: "${boton}" es más largo.`);
      }
    }
  }
}

/**
 * Rellena la plantilla con los valores. Que falte uno es un error ACÁ y no
 * en Meta: allá el mensaje sale con un hueco visible o se cae el envío, y
 * en los dos casos lo ve el cliente final.
 */
export function renderizar(body: string, valores: string[]): string {
  const vars = variablesDe(body);
  const cuantas = vars.length === 0 ? 0 : Math.max(...vars);
  if (valores.length !== cuantas) {
    throw new Error(
      `Esta plantilla necesita ${cuantas} valor${cuantas === 1 ? '' : 'es'} y llegaron ${valores.length}.`,
    );
  }
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => valores[Number(n) - 1] ?? '');
}
