import { textoDeEntorno } from '@iaxti/core';

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
  // Era una cadena de `??` y se rompía en el medio (#575): con
  // `ZAVU_API_BASE=""` ganaba la cadena vacía, el default no se miraba nunca y
  // TODA llamada a Zavu salía contra `''`. Fallaba como error de red, que es lo
  // último que alguien atribuye a una variable de entorno.
  return apiBase?.trim() || textoDeEntorno('ZAVU_API_BASE', ZAVU_API_BASE_DEFAULT);
}
