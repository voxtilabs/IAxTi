// El "día" de las métricas (#66). Suena trivial y no lo es: escribir el
// bucket con una noción de día y consultarlo con otra hace que los números
// de hoy desaparezcan del tablero.
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
