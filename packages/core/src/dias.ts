// El "día" del negocio. Suena trivial y no lo es: escribir un bucket con
// una noción de día y consultarlo con otra hace que los números de hoy
// desaparezcan del tablero (issue 182), y que una regla "una vez al día" se
// dispare dos veces la misma tarde.
//
// Vive en core, no en analytics, porque lo usan varios módulos y tener DOS
// definiciones de "hoy" es exactamente el bug que esto viene a cerrar.
//
// Lo que pasaba: `bump` guardaba el día en **UTC** y el rango del dashboard
// viajaba como `Date` de JS, que node-postgres serializa en hora LOCAL y el
// `::date` recortaba a la fecha local. En Chile (-03), entre las 21:00 y la
// medianoche eso son dos fechas distintas: lo escrito "hoy" quedaba un día
// por DELANTE del tope del rango y el tablero mostraba cero.
//
// La regla, entonces: el día es **el día del negocio en su zona horaria**, y
// viaja siempre como texto `AAAA-MM-DD`. Nunca se compara una fecha guardada
// contra un timestamp que alguien tenga que convertir.

/** Zona por defecto del producto; cada tenant puede tener la suya. */
export const TZ_POR_DEFECTO = 'America/Santiago';

/**
 * `AAAA-MM-DD` del instante dado, en la zona pedida. `en-CA` da justo ese
 * formato sin tener que armarlo a mano.
 */
export function diaEn(timeZone = TZ_POR_DEFECTO, cuando: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(cuando);
}

/**
 * `HH:MM` del instante dado, en la zona pedida (#1225).
 *
 * La hermana de `diaEn`, y nace del mismo defecto una capa más abajo: el
 * horario autónomo del agente se comparaba contra `now.getHours()`, que es el
 * reloj del PROCESO. Los contenedores corren en UTC, así que un negocio
 * chileno que escribía «08:00 a 22:00» obtenía 05:00 a 19:00 de su hora — el
 * bot dejaba de contestar solo tres horas antes de lo que decía su propia
 * configuración, sin un error en ninguna parte.
 *
 * `en-GB` con `hour12: false` da `HH:MM` de dos dígitos, que es el formato en
 * que el producto guarda el horario y por lo tanto comparable como texto.
 */
export function horaEn(timeZone = TZ_POR_DEFECTO, cuando: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(cuando);
}

/**
 * El día de la semana (0 = domingo) en la zona pedida.
 *
 * `getDay()` tiene el mismo problema que `getHours()`: a las 22:00 de un
 * domingo en Chile, un contenedor en UTC ya está en lunes. Un horario
 * configurado «solo de lunes a viernes» arrancaba el domingo a las 21:00.
 */
export function diaDeSemanaEn(timeZone = TZ_POR_DEFECTO, cuando: Date = new Date()): number {
  const corto = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(cuando);
  const dias = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const i = dias.indexOf(corto);
  // `indexOf` no puede fallar con `weekday: 'short'` en `en-US`, pero devolver
  // -1 en silencio dejaría a `days.includes(-1)` diciendo «no es ninguno de
  // los días», o sea el agente callado para siempre y nada que mirar.
  if (i === -1) throw new Error(`No pude leer el día de la semana en ${timeZone}: "${corto}".`);
  return i;
}

/** El rango por defecto del tablero: los últimos N días del negocio. */
export function ultimosDias(n: number, timeZone = TZ_POR_DEFECTO, hoy: Date = new Date()): {
  from: string;
  to: string;
} {
  return {
    from: diaEn(timeZone, new Date(hoy.getTime() - (n - 1) * 86_400_000)),
    to: diaEn(timeZone, hoy),
  };
}

/** ¿Es `AAAA-MM-DD` de verdad? Un rango que no se entiende se rechaza. */
export function esDia(valor: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valor)) return false;
  const d = new Date(`${valor}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && diaEn('UTC', d) === valor;
}

/**
 * `AAAA-MM-01` del mes del negocio: el ciclo mensual de cuotas y facturación.
 * Con el mes en UTC, las últimas tres horas de cada mes en Chile ya contaban
 * para el mes siguiente.
 */
export function mesEn(timeZone = TZ_POR_DEFECTO, cuando: Date = new Date()): string {
  return `${diaEn(timeZone, cuando).slice(0, 7)}-01`;
}
