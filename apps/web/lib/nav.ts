/**
 * Un destino del menú, tal como lo declara el `module.yaml` de su módulo y
 * lo entrega `GET /me/modules`.
 *
 * Vive acá y no en `app-shell.tsx` porque las pestañas de ajustes también
 * lo necesitan, y el shell las renderiza: importarlo de allá cerraba un
 * ciclo `app-shell → pestanas-ajustes → app-shell`. Lo cazó
 * dependency-cruiser, no yo.
 */
export interface NavItem {
  label: string;
  path: string;
  permission: string;
  /** En qué lista de la barra lateral va (#295). */
  grupo?: string;
  /** Con qué pantallas de ajustes comparte pestañas (#387). */
  seccion?: string;
}

/**
 * Un widget del inicio, tal como lo declara el `module.yaml` de su módulo
 * (#517).
 *
 * Estaban declarados y expuestos por `GET /me/modules` desde el principio, y
 * ningún componente los leía: el inicio mostraba la puesta en marcha para
 * siempre, también al negocio que terminó de configurarse hace medio año.
 *
 * El `id` es el contrato. Quién lo dibuja lo decide el frontend
 * (`components/inicio/widgets.tsx`); qué módulo lo trae y con qué permiso se
 * ve, el manifiesto. Así un módulo apagado se lleva el suyo sin desplegar,
 * igual que su entrada del menú.
 */
export interface WidgetItem {
  id: string;
  permission: string;
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
  return (await modulosDesdeLaApi(urlInterna)).flatMap((m) => m.nav);
}

/** Los widgets del inicio, de los módulos ACTIVOS (#517). */
export async function widgetsDesdeLaApi(urlInterna: string): Promise<WidgetItem[]> {
  return (await modulosDesdeLaApi(urlInterna)).flatMap((m) => m.widgets ?? []);
}

/**
 * Una sola lectura para las dos cosas.
 *
 * Next dedupe las peticiones iguales dentro del mismo render, así que pedir
 * la navegación y los widgets en la misma página no cuesta dos viajes. Y con
 * el mismo `revalidate`, que es lo que evita agotar el cupo por IP (arriba).
 */
async function modulosDesdeLaApi(
  urlInterna: string,
): Promise<Array<{ nav: NavItem[]; widgets?: WidgetItem[] }>> {
  try {
    const res = await fetch(`${urlInterna}/v1/me/modules`, {
      // No `no-store`: ver arriba. 60 s.
      next: { revalidate: 60 },
    });
    if (!res.ok) return [];
    return (await res.json()) as Array<{ nav: NavItem[]; widgets?: WidgetItem[] }>;
  } catch {
    // La API puede no estar en un build local: el shell degrada sin menú.
    return [];
  }
}
