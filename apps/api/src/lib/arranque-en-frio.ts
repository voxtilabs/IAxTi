/**
 * La base que todavía no despierta (#361).
 *
 * Dos webhooks entrantes respondieron 500 y los mensajes se perdieron. No
 * se reprodujo: fueron los primeros dos minutos después de un redespliegue,
 * y las 16 pruebas siguientes entraron sin problema. Esa misma noche
 * `/ready` dio 503 con «postgres: no respondió en 2000 ms», también en el
 * primer minuto de un contenedor recién levantado, y 317 ms después.
 *
 * O sea: la PRIMERA conexión al pooler de Supabase a veces pasa el timeout.
 * Es esperable —el pooler tiene que abrir su propia conexión abajo— y no es
 * un error de nadie. Lo que sí es un error nuestro es lo que hacíamos con
 * eso: responder 500.
 *
 * Un 500 le dice al proveedor "me rompí". Algunos reintentan, otros no, y
 * ninguno tiene por qué hacerlo. Un mensaje de un cliente que desaparece
 * porque el contenedor llevaba 40 segundos vivo es lo peor que puede pasar
 * en el camino de entrada.
 *
 * Acá hay dos cosas, y las dos importan:
 *  1. reintentar UNA vez: la segunda conexión casi siempre entra, y el
 *     costo es una espera corta en un caso raro;
 *  2. si igual no entra, que la respuesta sea 503 con `Retry-After`, que es
 *     lo que un proveedor sí sabe reintentar.
 */

/** Los mensajes con los que `pg` avisa que no pudo CONECTARSE. */
const DE_CONEXION = [
  'connection terminated due to connection timeout',
  'connection terminated unexpectedly',
  'timeout exceeded when trying to connect',
  'econnrefused',
  'etimedout',
  'ehostunreach',
  'enetunreach',
  'connect econnreset',
  'the server does not support ssl connections',
];

/**
 * ¿Esto fue "no pude llegar a la base" y no "la consulta estaba mal"?
 *
 * La diferencia manda: una consulta mal escrita reintentada es la misma
 * consulta mal escrita, y reintentarla esconde el error de verdad. Una
 * conexión que no entró, reintentada, entra.
 */
export function esFalloDeConexion(error: unknown): boolean {
  if (!error) return false;
  const codigo = (error as { code?: string }).code;
  if (typeof codigo === 'string') {
    // Los de Postgres son SQLSTATE de cinco caracteres (`42P01`); los del
    // sistema son nombres (`ECONNREFUSED`). Solo los segundos son de red.
    if (/^E[A-Z]+$/.test(codigo)) return true;
    if (/^[0-9A-Z]{5}$/.test(codigo)) return false;
  }
  const texto = String((error as { message?: string }).message ?? error).toLowerCase();
  return DE_CONEXION.some((m) => texto.includes(m));
}

/**
 * Corre `fn`, y si falló POR CONEXIÓN la vuelve a correr una vez.
 *
 * Un solo reintento a propósito: si la segunda tampoco entra, la base está
 * caída de verdad y seguir intentando solo alarga la respuesta al
 * proveedor, que tiene su propio timeout. Mejor decirle rápido que vuelva.
 */
export async function conReintentoDeConexion<T>(
  fn: () => Promise<T>,
  opts: { esperaMs?: number; avisar?: (error: unknown) => void } = {},
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (!esFalloDeConexion(error)) throw error;
    opts.avisar?.(error);
    await new Promise((r) => setTimeout(r, opts.esperaMs ?? 300));
    return fn();
  }
}
