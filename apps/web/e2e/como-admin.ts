import type { Page } from '@playwright/test';

/**
 * Entrar al tenant donde la usuaria del e2e es ADMIN (#815).
 *
 * El seed crea a la misma persona en varios negocios con roles distintos: en
 * el principal es SUPERVISOR y en el de tablas es ADMIN. Eso no es un detalle
 * del seed, es la matriz de SPEC §23: configurar el negocio —plantillas,
 * etiquetas, automatizaciones, retención, agenda— es del ADMIN, y un
 * SUPERVISOR coordina pero no configura.
 *
 * Hasta #815 daba igual, porque entrar por URL a una pantalla sin el permiso
 * la dibujaba lo mismo: estas pruebas venían ejercitando pantallas de
 * configuración con una usuaria que no puede configurarlas, y pasaban por el
 * agujero que #815 vino a tapar. Ahora el shell cierra la puerta, así que la
 * prueba que quiere ver el CONTENIDO tiene que entrar como quien de verdad lo
 * ve.
 *
 * Va con `addInitScript` y no tocando `localStorage` a mano porque se aplica
 * en cada navegación de la página, no solo en la primera: varias de estas
 * pruebas hacen dos o tres `goto`.
 *
 * Lo que NO hay que hacer con esto: usarlo para que una prueba de permisos
 * deje de molestar. Si una prueba se pone roja porque la puerta cerró y lo que
 * probaba era justamente la puerta, lo que cambia es la aserción.
 */
export async function comoAdmin(page: Page, auth: { tableTenantId: string }): Promise<void> {
  await page.addInitScript((id) => {
    localStorage.setItem('iaxti-tenant', id);
  }, auth.tableTenantId);
}
