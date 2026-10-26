/**
 * Un día `AAAA-MM-DD` escrito para leer, sin pasar por la zona del navegador
 * (#1076).
 *
 * El servidor manda algunos datos como DÍA y no como instante: el corte de
 * retención, la primera purga, el vencimiento de los enlaces. `new Date('2026-10-25')`
 * es medianoche UTC, así que `toLocaleDateString` lo baja un día en cualquier
 * zona al oeste de Greenwich — en Chile, siempre. Así, la ficha del contacto
 * afirmaba que el historial se borraba un día antes de lo que decía la
 * pantalla de ajustes sobre el MISMO dato.
 *
 * El ancla es mediodía y el formato se fija en UTC: las dos cosas, porque
 * cualquiera sola deja la mitad del corrimiento. Mismo patrón que
 * `fechaReporte` en `lib/reportes.ts`, que ya lo hacía bien para el eje del
 * gráfico.
 *
 * Para un `timestamptz` completo esto NO va: ahí la zona del navegador es
 * justamente lo que se quiere, y `new Date(iso).toLocaleDateString('es-CL')`
 * es correcto.
 */
const formato = new Intl.DateTimeFormat('es-CL', { timeZone: 'UTC' });

export function diaLegible(dia: string): string {
  return formato.format(new Date(`${dia}T12:00:00Z`));
}
