/** Contrato ya publicado de analytics/dashboard; no agrega métricas. */
export interface DashboardDto {
  metrics: Record<string, number>;
  primeraRespuesta: { medianaSeg: number | null; p90Seg: number | null; muestras: number };
  sinResponderAhora: number;
  tasaCierre: number | null;
  porDia: Array<{ day: string; conversaciones: number; resueltas: number; oportunidades: number }>;
  definiciones: Record<string, string>;
  /**
   * El mismo largo de ventana, pegado antes del rango pedido (#588, punto 5).
   *
   * Opcional, y no por prudencia decorativa: web y API son dos contenedores,
   * así que durante un despliegue el front nuevo convive un rato con la API
   * vieja. Si esto fuera obligatorio, `datos.anterior.comparable` tiraría un
   * TypeError y la pantalla de reportes quedaría en blanco mientras pasa el
   * rollout —cambiar una cifra sin comparación por una pantalla muerta—.
   * Sin el campo simplemente no hay comparación, que es lo que había antes.
   */
  anterior?: {
    from: string;
    to: string;
    metrics: Record<string, number>;
    tasaCierre: number | null;
    primeraRespuesta: { medianaSeg: number | null; muestras: number };
    comparable: boolean;
  };
}

export type Comparacion = {
  /** Lo que se lee en la tarjeta, ya armado. */
  texto: string;
  /** `null` cuando la cifra no mejoró ni empeoró, o cuando no se puede saber:
   *  pintar de verde un «sin comparación» le da una lectura que no tiene. */
  tono: 'good' | 'bad' | null;
  sube: boolean | null;
};

/**
 * Qué dice una cifra comparada con el período anterior (#588, punto 5).
 *
 * «142 conversaciones» no se puede leer; «142, un 18 % más que los 30 días
 * anteriores» sí. Pero el porcentaje solo existe en el caso fácil, y los otros
 * tres son justamente donde una tarjeta miente:
 *
 * - **Sin datos antes.** El negocio empezó dentro del rango pedido, así que no
 *   hubo período anterior. Un `+100 %` acá no es un redondeo optimista: es
 *   anunciar un crecimiento contra una ventana en la que la empresa no
 *   existía.
 * - **Antes era cero.** Dividir por cero no da «infinito por ciento», da que
 *   el porcentaje no es la herramienta. Se dice en números: «antes 0».
 * - **Falta la cifra.** La mediana de primera respuesta es `null` cuando no
 *   hubo conversaciones medidas, y `null` no es cero: es que no se midió.
 *
 * `mejorEsMenos` existe porque subir no siempre es bueno. Más conversaciones
 * es mejor; más segundos hasta la primera respuesta es peor, y pintar de verde
 * una demora que creció es peor que no comparar nada.
 */
export function compararCifras(
  actual: number | null,
  antes: number | null,
  opciones: { comparable: boolean; mejorEsMenos?: boolean; rango: string },
): Comparacion {
  const { comparable, mejorEsMenos = false, rango } = opciones;
  if (!comparable) return { texto: 'sin período anterior para comparar', tono: null, sube: null };
  if (actual === null || antes === null) {
    return { texto: `sin medir en ${rango}`, tono: null, sube: null };
  }
  if (actual === antes) return { texto: `igual que ${rango}`, tono: null, sube: null };

  const sube = actual > antes;
  // Subir es bueno salvo que la métrica mida demora o deuda.
  const tono: 'good' | 'bad' = sube === !mejorEsMenos ? 'good' : 'bad';
  if (antes === 0) return { texto: `antes 0, en ${rango}`, tono, sube };

  const pct = Math.round(Math.abs((actual - antes) / antes) * 100);
  // Un cambio que redondea a 0 % no es «igual»: son 1.004 contra 1.000. Decir
  // «0 % más» es ruido, así que se dice que se movió poco.
  if (pct === 0) return { texto: `casi igual que ${rango}`, tono: null, sube };
  return { texto: `${pct} % ${sube ? 'más' : 'menos'} que ${rango}`, tono, sube };
}

/** «1–7 oct», para que la tarjeta nombre contra qué compara y no diga «antes». */
export function rangoCorto(from: string, to: string) {
  return `${fechaReporte(from)} – ${fechaReporte(to)}`;
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
