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

const TRANSICIONES: Record<EstadoCita, EstadoCita[]> = {
  proposed: ['confirmed', 'cancelled'],
  confirmed: ['reminded', 'attended', 'no_show', 'cancelled', 'rescheduled'],
  // Recordada es confirmada que ya recibió su aviso: sigue el mismo camino.
  reminded: ['attended', 'no_show', 'cancelled', 'rescheduled'],
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
