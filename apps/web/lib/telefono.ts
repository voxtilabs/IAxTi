/**
 * El teléfono como se lee en voz alta (#1395).
 *
 * La base guarda E.164 («+56912345678»), que es lo correcto para hablar con
 * los proveedores y lo peor para leer: una cadena de once dígitos no se
 * reconoce de un vistazo ni se dicta por teléfono. En la lista y la ficha va
 * como la gente lo escribe: con el país, el área y el número separados.
 */

/**
 * E.164 → legible. Chilenos móviles y fijos de Santiago se separan; el resto
 * llega tal cual, porque inventarle una separación a un número de otro país
 * es adivinarle la regla a alguien que la conoce mejor.
 *
 * - `+56912345678` → `+56 9 1234 5678`
 * - `+56221234567` → `+56 2 2123 4567`
 * - `+14155550123` → `+14155550123`
 */
export function telefonoLegible(e164: string | null | undefined): string {
  if (!e164) return '—';
  // Once dígitos después de +56: área de un dígito (9 móvil, 2 Santiago) y
  // ocho de número, partidos al medio para leerse en dos golpes.
  const chileno = /^\+56(\d)(\d{8})$/.exec(e164);
  if (chileno) return `+56 ${chileno[1]} ${chileno[2].slice(0, 4)} ${chileno[2].slice(4)}`;
  return e164;
}
