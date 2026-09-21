/**
 * Un destino del menú, tal como lo declara el `module.yaml` de su módulo y
 * lo entrega `GET /me/modules`.
 */
export interface NavItem {
  label: string;
  path: string;
  permission: string;
  /** En qué lista de la barra lateral va (#295). */
  grupo?: string;
}

/**
 * La navegación, pedida UNA vez y cacheada (#400).
 *
 * Estaba copiada en 26 páginas, todas con `cache: 'no-store'`. Esas llamadas
 * salen del servidor del web SIN `x-tenant-id`, así que el limitador cae a
 * su último recurso —el cupo por IP— y las 26 comparten uno solo de 120 por
 * minuto. Next además precarga los enlaces del menú al pasar el cursor, y
 * cada precarga renderiza la página en el servidor: una llamada más cada
 * vez. Con la barra lateral de #295 hay más enlaces a la vista, así que se
 * agotaba en segundos y el producto respondía "Demasiadas solicitudes".
 *
 * Lo que devuelve son los módulos activos y su navegación: cambia cuando se
 * despliega, no entre dos clics. Un minuto de caché es más que suficiente, y
 * el costo es que un módulo recién encendido tarde hasta un minuto en
 * aparecer en el menú.
 */
export async function navDesdeLaApi(urlInterna: string): Promise<NavItem[]> {
  try {
    const res = await fetch(`${urlInterna}/v1/me/modules`, {
      // No `no-store`: ver arriba. 60 s.
      next: { revalidate: 60 },
    });
    if (!res.ok) return [];
    const modules = (await res.json()) as Array<{ nav: NavItem[] }>;
    return modules.flatMap((m) => m.nav);
  } catch {
    // La API puede no estar en un build local: el shell degrada sin menú.
    return [];
  }
}
