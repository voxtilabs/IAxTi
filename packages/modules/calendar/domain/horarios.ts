/**
 * Los huecos libres (SPEC §16). Aritmética pura: sin base ni zona horaria
 * adentro. Quien llama trae las citas que ya existen y decide el día; acá
 * solo se resta.
 *
 * Está separado a propósito. Calcular disponibilidad es la clase de cosa
 * que se rompe en los bordes —la cita que termina justo cuando empieza otra,
 * el respiro que se come el último hueco— y esos bordes se prueban mejor
 * con números que con fechas.
 */

export interface VentanaDelDia {
  /** Minutos desde la medianoche, hora del NEGOCIO. */
  inicio: number;
  fin: number;
  duracion: number;
  respiro: number;
}

export interface Ocupado {
  inicio: number;
  fin: number;
}

/**
 * Los comienzos de hueco que caben. Un hueco vale si la cita entera cabe
 * antes del cierre y no pisa —ni roza el respiro de— nada que ya esté.
 */
export function huecosLibres(ventana: VentanaDelDia, ocupados: Ocupado[]): number[] {
  const { inicio, fin, duracion, respiro } = ventana;
  if (duracion <= 0) return [];
  const paso = duracion + respiro;
  const libres: number[] = [];

  for (let t = inicio; t + duracion <= fin; t += paso) {
    const choca = ocupados.some((o) => {
      // El respiro se cuenta a los DOS lados de lo ocupado: si alguien sale
      // a las 11:00 y el respiro es 15 minutos, las 11:00 no sirve.
      const desde = o.inicio - respiro;
      const hasta = o.fin + respiro;
      return t < hasta && t + duracion > desde;
    });
    if (!choca) libres.push(t);
  }
  return libres;
}

/** "14:30" para mostrar; los minutos son para calcular. */
export function comoHora(minutos: number): string {
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function desdeHora(texto: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec((texto ?? '').trim());
  if (!m) throw new Error('La hora va como "09:00".');
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`Esa hora no existe: ${texto}.`);
  return h * 60 + min;
}
