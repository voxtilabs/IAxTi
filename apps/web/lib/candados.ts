import type { NavItem } from '../components/app-shell';

/**
 * Qué rutas del menú van con candado (issue 215).
 *
 * Se cruza por ID DE MÓDULO, no por el prefijo del permiso: el menú llega
 * aplanado y ahí ya se perdió de qué módulo salió cada item, y adivinar por
 * el permiso se equivoca justo en los casos que importan — `apikeys.manage`
 * y `roles.read` los declara `authorization`, no unos módulos llamados
 * "apikeys" y "roles".
 */
export function rutasConCandado(
  modulos: Array<{ id: string; nav?: NavItem[] }>,
  acceso: Array<{ id: string; acceso: 'completo' | 'solo_lectura' }>,
): Set<string> {
  const limitados = new Set(acceso.filter((m) => m.acceso === 'solo_lectura').map((m) => m.id));
  const rutas = new Set<string>();
  for (const modulo of modulos) {
    if (!limitados.has(modulo.id)) continue;
    for (const item of modulo.nav ?? []) rutas.add(item.path);
  }
  return rutas;
}
