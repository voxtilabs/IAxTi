// Horario hábil y ajustes de la bandeja (SPEC §11, #38). Puro: sin base.
// El SLA de primera respuesta corre SOLO en horario hábil, así que aquí vive
// la aritmética de minutos hábiles entre dos instantes, con zona horaria.

export interface BusinessHours {
  /** Días hábiles, 0 = domingo … 6 = sábado. */
  dias: number[];
  desde: string; // 'HH:MM' hora local
  hasta: string; // 'HH:MM'
  zona: string; // IANA, p. ej. America/Santiago
}

export const DEFAULT_HORARIO: BusinessHours = {
  dias: [1, 2, 3, 4, 5],
  desde: '09:00',
  hasta: '19:00',
  zona: 'America/Santiago',
};

export type AssignmentMode = 'manual' | 'round_robin' | 'last_owner' | 'ia_horario';

/** Horario de silencio (SPEC §8): ningún envío INICIADO POR EL NEGOCIO
 *  sale en este rango. Cruza la medianoche (21:00 → 08:00). */
export interface QuietHours {
  desde: string; // 'HH:MM'
  hasta: string;
  zona: string;
}

export const DEFAULT_SILENCIO: QuietHours = {
  desde: '21:00',
  hasta: '08:00',
  zona: 'America/Santiago',
};

export interface BandejaSettings {
  assignmentMode: AssignmentMode;
  /** `new` sin dueño por más de esto avisa al supervisor (SPEC §11). */
  alertaSinDuenoMinutos: number;
  /** SLA de primera respuesta, en minutos hábiles. */
  slaPrimeraRespuestaMinutos: number;
  horario: BusinessHours;
  silencio: QuietHours;
}

const MODOS: AssignmentMode[] = ['manual', 'round_robin', 'last_owner', 'ia_horario'];

/** Lee `tenants.settings.bandeja` con los por-defecto de la spec. */
export function bandejaSettings(settings: Record<string, unknown> | null | undefined): BandejaSettings {
  const raw = (settings?.bandeja ?? {}) as Partial<{
    assignmentMode: string;
    alertaSinDuenoMinutos: number;
    slaPrimeraRespuestaMinutos: number;
    horario: Partial<BusinessHours>;
    silencio: Partial<QuietHours>;
  }>;
  return {
    assignmentMode: MODOS.includes(raw.assignmentMode as AssignmentMode)
      ? (raw.assignmentMode as AssignmentMode)
      : 'manual',
    alertaSinDuenoMinutos:
      typeof raw.alertaSinDuenoMinutos === 'number' && raw.alertaSinDuenoMinutos >= 1
        ? Math.floor(raw.alertaSinDuenoMinutos)
        : 10,
    slaPrimeraRespuestaMinutos:
      typeof raw.slaPrimeraRespuestaMinutos === 'number' && raw.slaPrimeraRespuestaMinutos >= 1
        ? Math.floor(raw.slaPrimeraRespuestaMinutos)
        : 30,
    horario: {
      dias: Array.isArray(raw.horario?.dias) && raw.horario.dias.length > 0
        ? raw.horario.dias.filter((d): d is number => typeof d === 'number' && d >= 0 && d <= 6)
        : DEFAULT_HORARIO.dias,
      desde: raw.horario?.desde ?? DEFAULT_HORARIO.desde,
      hasta: raw.horario?.hasta ?? DEFAULT_HORARIO.hasta,
      zona: raw.horario?.zona ?? DEFAULT_HORARIO.zona,
    },
    silencio: {
      desde: raw.silencio?.desde ?? DEFAULT_SILENCIO.desde,
      hasta: raw.silencio?.hasta ?? DEFAULT_SILENCIO.hasta,
      zona: raw.silencio?.zona ?? DEFAULT_SILENCIO.zona,
    },
  };
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function partsIn(zona: string, instante: Date): LocalParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zona,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  });
  const p: Record<string, string> = {};
  for (const parte of fmt.formatToParts(instante)) p[parte.type] = parte.value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour) % 24, // Intl puede dar "24" a medianoche
    minute: Number(p.minute),
    weekday: WEEKDAYS[p.weekday] ?? 0,
  };
}

function hhmm(v: string): number {
  const [h, m] = v.split(':').map(Number);
  return h * 60 + (m || 0);
}

/**
 * Minutos HÁBILES entre dos instantes según el horario del negocio.
 * Camina día a día en la zona del tenant (los cambios de hora chilenos se
 * absorben con precisión de minuto, suficiente para un SLA de 30).
 */
export function minutosHabilesEntre(desde: Date, hasta: Date, horario: BusinessHours): number {
  if (hasta <= desde) return 0;
  const inicio = hhmm(horario.desde);
  const fin = hhmm(horario.hasta);
  let total = 0;
  // Avanza en pasos de un día calendario (86 400 000 ms está bien: solo
  // usamos el instante para leer el día local; tope de 62 días por sanidad).
  let cursor = new Date(desde);
  for (let i = 0; i < 62 && cursor < hasta; i++) {
    const dia = partsIn(horario.zona, cursor);
    if (horario.dias.includes(dia.weekday)) {
      const minutoLocal = dia.hour * 60 + dia.minute;
      // Ventana hábil restante de ESTE día local, en minutos locales.
      const desdeMin = Math.max(minutoLocal, inicio);
      // ¿Hasta dónde llega `hasta` dentro de este día local?
      const finDia = partsIn(horario.zona, hasta);
      const mismoDia =
        finDia.year === dia.year && finDia.month === dia.month && finDia.day === dia.day;
      const hastaMin = mismoDia ? Math.min(finDia.hour * 60 + finDia.minute, fin) : fin;
      if (hastaMin > desdeMin) total += hastaMin - desdeMin;
      if (mismoDia) break;
    }
    // Salta al comienzo del día local siguiente: suma lo que falta del día.
    const restanteHoy = 24 * 60 - (dia.hour * 60 + dia.minute);
    cursor = new Date(cursor.getTime() + (restanteHoy + 1) * 60_000);
  }
  return total;
}

/** ¿Estamos dentro del horario de silencio? Cruza medianoche sin drama. */
export function enSilencio(silencio: QuietHours, now: Date = new Date()): boolean {
  const p = partsIn(silencio.zona, now);
  const minuto = p.hour * 60 + p.minute;
  const desde = hhmm(silencio.desde);
  const hasta = hhmm(silencio.hasta);
  if (desde === hasta) return false; // sin silencio configurado
  return desde < hasta ? minuto >= desde && minuto < hasta : minuto >= desde || minuto < hasta;
}

/** Milisegundos hasta que TERMINE el silencio (para reprogramar el envío). */
export function msHastaFinDeSilencio(silencio: QuietHours, now: Date = new Date()): number {
  if (!enSilencio(silencio, now)) return 0;
  const p = partsIn(silencio.zona, now);
  const minuto = p.hour * 60 + p.minute;
  const hasta = hhmm(silencio.hasta);
  const faltan = hasta > minuto ? hasta - minuto : 24 * 60 - minuto + hasta;
  return faltan * 60_000;
}
