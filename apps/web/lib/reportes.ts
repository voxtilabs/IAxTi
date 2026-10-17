/** Contrato ya publicado de analytics/dashboard; no agrega métricas. */
export interface CostoEnPesosDto {
  usd: number;
  /** `null` es «no sabemos cuánto es en pesos», que no es cero. */
  clp: number | null;
  /** Días CON gasto que quedaron fuera de la suma por no tener dólar. */
  diasSinCambio: number;
}

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
  /**
   * Los costos en pesos (#796). Opcional por lo MISMO que `anterior`: durante
   * un despliegue el front nuevo convive con la API vieja, y una pantalla en
   * blanco es peor que una cifra sin convertir.
   */
  costos?: {
    meta: CostoEnPesosDto;
    ia: CostoEnPesosDto;
  };
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

/**
 * El costo como se muestra: en pesos, y diciendo lo que no se pudo convertir.
 *
 * La regla de negocio pide los costos «en pesos» (#796). Hasta ahora el panel
 * mostraba dólares al lado de ingresos en pesos, y un tablero que pone
 * $1.240.000 arriba y US$ 12,40 abajo invita a restarlos: para una pyme
 * chilena eso no es una conversión pendiente, es un margen mal calculado.
 *
 * Los dólares no desaparecen: van en la explicación, porque la factura de Meta
 * llega en dólares y alguien va a querer cuadrarla.
 *
 * Y los tres estados se dicen distinto, que es el punto:
 *
 *  · convertido        → «$11.809» y el dólar en la explicación;
 *  · sin gasto         → «—»;
 *  · sin tipo de cambio→ el valor en dólares y por qué no está en pesos.
 *
 * El tercero no es un detalle: si se mostrara el peso igual, el número saldría
 * más bajo que el real —faltan días— sin que nada avise.
 */
export function costoMostrable(
  costo: CostoEnPesosDto | undefined,
  usdDecimales: number,
): { valor: string; nota: string } {
  // Sin el campo: API vieja durante el rollout. Se muestra lo que había.
  if (!costo) return { valor: '', nota: '' };
  if (costo.usd <= 0) return { valor: '—', nota: '' };
  const enDolares = `USD ${costo.usd.toFixed(usdDecimales)}`;
  if (costo.clp === null) {
    return {
      valor: enDolares,
      nota: `Sin tipo de cambio para ${costo.diasSinCambio === 1 ? 'ese día' : 'esos días'}: se muestra en dólares para no convertir con el dólar de otra fecha.`,
    };
  }
  const nota =
    costo.diasSinCambio > 0
      ? `Equivale a ${enDolares}. Faltan ${costo.diasSinCambio} ${costo.diasSinCambio === 1 ? 'día' : 'días'} sin tipo de cambio, así que el monto en pesos está incompleto.`
      : `Equivale a ${enDolares}, convertido con el dólar observado de cada día.`;
  return { valor: new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 }).format(costo.clp), nota };
}
