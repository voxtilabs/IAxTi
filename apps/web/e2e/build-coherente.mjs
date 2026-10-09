/**
 * ¿El standalone y los estáticos son del MISMO build? (#637)
 *
 * El e2e corre el `server.js` del standalone y le copia encima los estáticos de
 * `.next/static`. Son dos lados de un mismo build, y cuando no lo son el
 * síntoma miente sobre su causa: el servidor pide
 * `chunks/9863-<hash nuevo>.js`, el disco solo tiene el viejo, sale 404 →
 * `ChunkLoadError` → «Application error: a client-side exception has occurred»
 * → la aplicación no monta → **las 71 pruebas fallan** con mensajes que no
 * apuntan a nada (`element(s) not found`).
 *
 * Lo cruel es la forma: el código SIN cambios pasa —sus hashes calzan con lo
 * copiado— así que la comparación «sí es mi cambio / no es mi cambio» da el
 * resultado equivocado con toda confianza. #635 arregló la mitad que se
 * arreglaba copiando siempre; esta es la otra: que el standalone también sea
 * del build de ahora.
 *
 * Vive en su propio archivo para poder probarlo. El runner es un orquestador
 * que arranca cuatro procesos: importarlo desde una prueba sería levantar el
 * e2e entero para comprobar una comparación de dos cadenas.
 */

/**
 * `null` si no hay nada que objetar; si no, el mensaje que hay que mostrar
 * ANTES de correr nada.
 *
 * Un `BUILD_ID` ausente no se trata como desacuerdo: hay builds de Next donde
 * el archivo no está en los dos lados, y negarse por una ausencia dejaría el
 * e2e sin correr por un motivo que no es el problema. Lo que se caza es el
 * desacuerdo EXPLÍCITO, que es el que produce la mezcla.
 */
export function porQueNoCorrer({ delStandalone, delNext }) {
  if (!delStandalone || !delNext) return null;
  if (delStandalone === delNext) return null;
  return (
    'e2e: el standalone es de otro build que los estáticos ' +
    `(standalone ${delStandalone}, .next ${delNext}). ` +
    'Corre `pnpm turbo build --filter=@iaxti/web` y vuelve a intentar: servir la ' +
    'mezcla da ChunkLoadError y deja toda la suite roja por algo que no es tu cambio.'
  );
}
