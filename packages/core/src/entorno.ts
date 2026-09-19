/**
 * Enteros que vienen del entorno, sin sorpresas (#241 y parientes).
 *
 * `Number(process.env.X ?? 120)` se lee bien y falla mal:
 *
 *   X="tres"  → NaN   → comparaciones falsas, fechas inválidas, listen(NaN)
 *   X=""      → 0     → y `??` NO lo atrapa: solo cubre null y undefined
 *
 * La cadena vacía es el caso que muerde, porque dejar una variable vacía en
 * el panel es la forma normal de "desactivarla". Y con `Number("") === 0` un
 * cero significa cosas muy distintas según dónde caiga:
 *
 *   PORT=""                      → listen(0) escucha en un puerto AL AZAR;
 *                                  el proxy apunta al 3000 y responde 404
 *   WHATSAPP_MSGS_PER_SECOND=""  → no sale ni un mensaje
 *   RATE_LIMIT_PER_MINUTE=""     → toda petición responde 429
 *   DB_CONNECT_TIMEOUT_MS=""     → para pg, 0 es SIN tope: se cuelga en vez
 *                                  de fallar
 *
 * Ninguno de esos se ve como "la variable está mal": se ven como que el
 * producto está roto, y cada uno manda a investigar a otra parte.
 *
 * Acá un valor inválido cae al por-defecto y LO DICE. Callarse sería repetir
 * el problema en otro lugar.
 */
export function enteroDeEntorno(
  nombre: string,
  pordefecto: number,
  opciones: { min?: number; env?: NodeJS.ProcessEnv } = {},
): number {
  const env = opciones.env ?? process.env;
  const min = opciones.min ?? 1;
  const crudo = env[nombre];
  // Ausente o en blanco: no está configurada, y eso no es un error.
  if (crudo === undefined || crudo.trim() === '') return pordefecto;
  const n = Number(crudo);
  if (!Number.isFinite(n) || n < min) {
    console.warn(
      `entorno: ${nombre}="${crudo}" no sirve (se esperaba un número ≥ ${min}). ` +
        `Se usa ${pordefecto}. Revísala donde se configura el ambiente.`,
    );
    return pordefecto;
  }
  return n;
}
