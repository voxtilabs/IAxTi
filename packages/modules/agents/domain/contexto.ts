/**
 * El ancla temporal del contexto (#1049).
 *
 * Sin saber qué día es, «el próximo jueves a las 4» no tiene traducción a
 * ISO y toda acción de agenda nace muerta — medido: el modelo entregaba
 * `"fecha_hora": "próximo jueves 16:00"` y la ruta la rechazaba. En palabras
 * para que el modelo converse, y en ISO para que calcule. Zona del defecto
 * del producto (America/Santiago): las pymes del SPEC son chilenas, y el día
 * que un tenant viva en otra zona esto recibe la suya.
 */
export function fechaDeHoy(ahora: Date): string {
  const zona = 'America/Santiago';
  const enPalabras = new Intl.DateTimeFormat('es-CL', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: zona,
  }).format(ahora);
  return `${enPalabras} (${zona}; instante ISO: ${ahora.toISOString()})`;
}
