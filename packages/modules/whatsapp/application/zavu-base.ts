/**
 * La base de la API de Zavu, en un archivo propio.
 *
 * Vive sola porque la usan el adaptador y el cliente de plantillas, y
 * tenerla en uno de los dos obligaba a que se importaran entre ellos: un
 * ciclo que TypeScript tolera y que en tiempo de ejecución deja la constante
 * sin definir según el orden en que se carguen.
 */
export const ZAVU_API_BASE_DEFAULT = 'https://api.zavu.dev/v1';

export function baseDeZavu(apiBase?: string): string {
  return apiBase ?? process.env.ZAVU_API_BASE ?? ZAVU_API_BASE_DEFAULT;
}
