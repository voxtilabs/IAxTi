/** Contrato ya publicado de analytics/dashboard; no agrega métricas. */
export interface DashboardDto {
  metrics: Record<string, number>;
  primeraRespuesta: { medianaSeg: number | null; p90Seg: number | null; muestras: number };
  sinResponderAhora: number;
  tasaCierre: number | null;
  porDia: Array<{ day: string; conversaciones: number; resueltas: number; oportunidades: number }>;
  definiciones: Record<string, string>;
}

export function rangoReporte(dias: number, ahora = new Date()) {
  return {
    from: new Date(ahora.getTime() - (dias - 1) * 86_400_000).toISOString().slice(0, 10),
    to: ahora.toISOString().slice(0, 10),
  };
}

/** El agregado omite días sin eventos; el eje conserva cada día del rango. */
export function diasDelReporte(datos: DashboardDto['porDia'], from: string, to: string) {
  const porFecha = new Map(datos.map((d) => [d.day, d]));
  const dias: DashboardDto['porDia'] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    dias.push(porFecha.get(day) ?? { day, conversaciones: 0, resueltas: 0, oportunidades: 0 });
  }
  return dias;
}

const fecha = new Intl.DateTimeFormat('es-CL', { day: 'numeric', month: 'short', timeZone: 'UTC' });
export function fechaReporte(day: string) { return fecha.format(new Date(`${day}T12:00:00Z`)); }
