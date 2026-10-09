/**
 * La prioridad de una conversación (#550).
 *
 * `conversations.priority` existía desde la primera migración con su CHECK
 * completo, estaba en el SPEC, estaba en el tipo y **la API la devolvía en cada
 * conversación de la bandeja**. Cero escrituras: siempre `'normal'`.
 *
 * Vive en `domain/` y no en `application/` porque es una definición del negocio
 * —qué prioridades existen y cuál pesa más— y porque la necesitan los dos lados:
 * `inbox` para ordenar y `conversations` para validar al escribir. Puestas en
 * cualquiera de los dos, el otro tenía que importarlo y el grafo se cerraba en
 * un ciclo; lo cazó `dependency-cruiser`.
 */

/**
 * De menor a mayor urgencia, y el ÍNDICE es el rango.
 *
 * El orden alfabético del texto no tiene nada que ver con la urgencia
 * ('alta' < 'baja' < 'normal' < 'urgente'), así que un `ORDER BY priority DESC`
 * habría puesto «urgente» primero por casualidad y «alta» al final.
 *
 * Los números 0…3 son los MISMOS que el `CASE` de la consulta y los del índice
 * de la migración `0009`. Reordenar este arreglo sin tocar los otros dos rompe
 * la paginación en silencio: el cursor lleva el rango, y si el rango del cursor
 * no coincide con el del `ORDER BY`, la segunda página se salta filas.
 */
export const PRIORIDADES = ['baja', 'normal', 'alta', 'urgente'] as const;
export type Prioridad = (typeof PRIORIDADES)[number];

/** El rango numérico, para el cursor. `normal` si llega algo que no existe. */
export function rangoDePrioridad(prioridad: string | null | undefined): number {
  const i = PRIORIDADES.indexOf((prioridad ?? 'normal') as Prioridad);
  return i === -1 ? PRIORIDADES.indexOf('normal') : i;
}

/**
 * La expresión SQL que ordena. La MISMA que indexa `0009`.
 *
 * Va acá, al lado de los números, para que las dos mitades se lean juntas: si
 * se separan, el índice deja de servir para ordenar y nadie se entera hasta el
 * día en que la bandeja tiene doscientas conversaciones — que es exactamente el
 * día en que la prioridad importa.
 */
export const RANGO_SQL = `CASE c.priority
       WHEN 'urgente' THEN 3
       WHEN 'alta'    THEN 2
       WHEN 'normal'  THEN 1
       ELSE 0
     END`;
