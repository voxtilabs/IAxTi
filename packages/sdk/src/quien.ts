/**
 * Quién hizo algo (#697).
 *
 * El servidor resuelve el id a un nombre: la pantalla nunca muestra un UUID,
 * que no significa nada para quien lo lee.
 *
 * - `nombre` null: existe la persona pero no completó su perfil.
 * - `enElEquipo` false: ya no está en este negocio, y eso es lo que se dice.
 * - `enElEquipo` null: la pregunta no corresponde (lo hizo alguien de la
 *   plataforma, que no pertenece al equipo de ningún negocio).
 */
export interface Quien {
  userId: string;
  nombre: string | null;
  enElEquipo: boolean | null;
}
