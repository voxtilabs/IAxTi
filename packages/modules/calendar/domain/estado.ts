/**
 * La cita y su vida (SPEC §16).
 *
 * `proposed` existe porque la IA ofrece horarios y la persona todavía no
 * dijo que sí. Mientras está propuesta ocupa su hueco, igual que una
 * confirmada: no se promete la misma hora a dos personas.
 */
export const ESTADOS_CITA = [
  'proposed',
  'confirmed',
  'reminded',
  'attended',
  'no_show',
  'cancelled',
  'rescheduled',
] as const;
export type EstadoCita = (typeof ESTADOS_CITA)[number];

/**
 * `rescheduled` NO es alcanzable, y es a propósito (#836).
 *
 * Estaba abierto desde `confirmed` y `reminded`, y era un callejón con una
 * fuga: nada en el producto reagenda —no hay función que mueva la hora ni que
 * cree la cita de reemplazo, y la tool `calendar.reschedule` está en la lista
 * de las CERRADAS por ADR-0017—, así que el único camino hasta acá era forzar
 * el estado por la API.
 *
 * Y llegar ahí dejaba las cosas peor que antes:
 *
 *  - `TRANSICIONES.rescheduled` está vacío, así que la cita queda congelada
 *    para siempre;
 *  - `ocupaAgenda('rescheduled')` es false, así que IAxTi libera la hora;
 *  - y el evento sigue ocupando esa hora en **Google Calendar**, porque el
 *    único `if` que cancela allá es `input.to === 'cancelled'`.
 *
 * O sea: la hora se ofrece de nuevo a otra persona mientras sigue tomada en el
 * calendario del negocio. Y nadie se enteraba, porque el mapa de eventos solo
 * cubre attended/no_show/cancelled.
 *
 * El estado se queda en `ESTADOS_CITA` y en el CHECK de la migración: hay que
 * poder leer una fila vieja que lo tenga, y el día que reagendar exista (#836)
 * el camino se vuelve a abrir CON la función que lo sostiene. Lo que no puede
 * seguir es que se pueda entrar sin que exista la salida.
 */
const TRANSICIONES: Record<EstadoCita, EstadoCita[]> = {
  proposed: ['confirmed', 'cancelled'],
  confirmed: ['reminded', 'attended', 'no_show', 'cancelled'],
  // Recordada es confirmada que ya recibió su aviso: sigue el mismo camino.
  reminded: ['attended', 'no_show', 'cancelled'],
  // Los finales son finales. Una cita a la que alguien no llegó no se
  // "arregla" después cambiándole el estado: se agenda otra.
  attended: [],
  no_show: [],
  cancelled: [],
  rescheduled: [],
};

export function assertTransicionCita(from: EstadoCita, to: EstadoCita): void {
  if (!TRANSICIONES[from]?.includes(to)) {
    throw new Error(`Transición de cita inválida: ${from} → ${to}`);
  }
}

/** Las que ocupan un lugar en la agenda. Una cancelada libera su hora. */
export function ocupaAgenda(estado: EstadoCita): boolean {
  return estado === 'proposed' || estado === 'confirmed' || estado === 'reminded';
}
