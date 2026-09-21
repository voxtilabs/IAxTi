import type { Page } from '@playwright/test';

/**
 * Elegir una opción en el Select del sistema (#293).
 *
 * `selectOption()` de Playwright solo funciona con un `<select>` nativo, y
 * el producto ya no tiene ninguno: el de Radix es un botón que abre un
 * panel en un portal. Los e2e fallaban con "Element is not a <select>
 * element", que es la forma en que Playwright dice exactamente eso.
 *
 * Va acá y no copiado en cada spec para que el próximo que se escriba no
 * tenga que redescubrirlo.
 */
export async function elegir(
  page: Page,
  campo: { nombre: string; exacto?: boolean },
  opcion: string | { nombre: string },
): Promise<void> {
  await page.getByRole('combobox', { name: campo.nombre, exact: campo.exacto }).click();
  const etiqueta = typeof opcion === 'string' ? opcion : opcion.nombre;
  // El panel va en un portal al final del body: se busca por rol y no
  // dentro del formulario.
  await page.getByRole('option', { name: etiqueta, exact: true }).click();
}

/**
 * Cuando lo que se tiene es el VALOR y no el texto visible.
 *
 * Radix pone el valor en `data-value` del item, así que se puede apuntar
 * igual de preciso que con `selectOption(valor)`.
 */
export async function elegirPorValor(
  page: Page,
  campo: { nombre: string; exacto?: boolean },
  valor: string,
): Promise<void> {
  await page.getByRole('combobox', { name: campo.nombre, exact: campo.exacto }).click();
  await page.locator(`[role="option"][data-value="${valor}"]`).click();
}
