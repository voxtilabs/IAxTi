import type { PoolClient } from 'pg';

/**
 * Los hilos con el Agente General: guardarlos, listarlos, leerlos (#1131).
 *
 * El controlador decía que no guardarlos «es a propósito», y lo era mientras
 * el agente fue un popup. Desde #1135 es la pantalla «Tu asistente», y el
 * dueño del producto pidió ver sus conversaciones anteriores — que es elegir
 * guardarlas (ADR-0029).
 *
 * Lo que de verdad lo justifica no es la comodidad: el agente PROPONE
 * acciones que el humano aprueba, y una propuesta sin resolver que
 * desaparece en una recarga deja al dueño sin saber qué le habían ofrecido.
 *
 * El hilo es PERSONAL. Dos personas del mismo negocio configurando a la vez
 * no se pisan, y lo que una le contó al agente no aparece en la pantalla de
 * la otra.
 */
/**
 * Un turno tal como se guarda: rol y texto, MÁS lo que la pantalla dibuje.
 *
 * El índice abierto no es pereza: lo que hay que poder recuperar incluye los
 * pasos que dio el agente y si una propuesta se aplicó o se descartó, y eso
 * lo define la pantalla. Tipar solo `role` y `content` haría que el tipo
 * mintiera sobre lo que esta tabla guarda — y el compilador rechazaría
 * justamente los turnos completos, que son los que importan.
 */
export interface TurnoGuardado {
  role: string;
  content: string;
  [otro: string]: unknown;
}

export interface HiloResumen {
  id: string;
  titulo: string;
  turnos: number;
  updatedAt: string;
}

export interface Hilo extends HiloResumen {
  /** El hilo tal como se vuelve a dibujar: con sus pasos y sus propuestas. */
  turnosCompletos: unknown[];
}

/** 30 días sin tocarlo y se va (ADR-0029). */
export const DIAS_DE_RETENCION = 30;

/**
 * El rótulo de la conversación: lo primero que la persona escribió.
 *
 * Sin pedírselo al modelo. Nombrar cada conversación costaría una llamada
 * por hilo para bautizar algo que el usuario ya bautizó al escribir, y la
 * primera frase es, casi siempre, exactamente de qué se trata.
 */
export function tituloDesdeElPrimerTurno(turnos: readonly TurnoGuardado[]): string {
  const primero = turnos.find((t) => t.role === 'user')?.content.trim() ?? '';
  const limpio = primero.replace(/\s+/g, ' ');
  if (limpio === '') return 'Sin título';
  return limpio.length > 80 ? `${limpio.slice(0, 79)}…` : limpio;
}

/** Las conversaciones de esta persona en este negocio, la última primero. */
export async function listarHilos(
  c: PoolClient,
  input: { tenantId: string; userId: string; limite?: number },
): Promise<HiloResumen[]> {
  const r = await c.query(
    `SELECT id, titulo, jsonb_array_length(turnos) AS turnos,
            to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at
       FROM agent_general_threads
      WHERE tenant_id = $1 AND user_id = $2
      ORDER BY updated_at DESC
      LIMIT $3`,
    [input.tenantId, input.userId, Math.min(input.limite ?? 20, 50)],
  );
  return r.rows.map((f) => ({
    id: f.id as string,
    titulo: f.titulo as string,
    turnos: Number(f.turnos),
    updatedAt: f.updated_at as string,
  }));
}

/** Un hilo completo, para volver a dibujarlo. */
export async function leerHilo(
  c: PoolClient,
  input: { tenantId: string; userId: string; id: string },
): Promise<Hilo | null> {
  const r = await c.query(
    `SELECT id, titulo, turnos,
            to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at
       FROM agent_general_threads
      WHERE tenant_id = $1 AND user_id = $2 AND id = $3`,
    [input.tenantId, input.userId, input.id],
  );
  const f = r.rows[0];
  if (!f) return null;
  const turnos = (f.turnos as unknown[]) ?? [];
  return {
    id: f.id as string,
    titulo: f.titulo as string,
    turnos: turnos.length,
    updatedAt: f.updated_at as string,
    turnosCompletos: turnos,
  };
}

/**
 * Guarda el hilo entero, creándolo o reemplazándolo.
 *
 * Se reemplaza completo en cada vuelta y no se van agregando turnos: lo que
 * cambia no es solo el último: una propuesta que estaba pendiente pasa a
 * aplicada, y eso vive en un turno anterior. Guardar «el último» dejaría el
 * estado de las propuestas congelado en lo que era al escribirlas.
 */
export async function guardarHilo(
  c: PoolClient,
  input: { tenantId: string; userId: string; id?: string | null; turnos: readonly TurnoGuardado[] },
): Promise<{ id: string }> {
  const titulo = tituloDesdeElPrimerTurno(input.turnos);
  const json = JSON.stringify(input.turnos);
  if (input.id) {
    const r = await c.query(
      `UPDATE agent_general_threads
          SET turnos = $4::jsonb, titulo = $5, updated_at = now()
        WHERE tenant_id = $1 AND user_id = $2 AND id = $3
      RETURNING id`,
      [input.tenantId, input.userId, input.id, json, titulo],
    );
    // Si no existe —se purgó, o viene un id de otra persona— se crea uno
    // nuevo en vez de perder la conversación en curso.
    if (r.rows[0]) return { id: r.rows[0].id as string };
  }
  const r = await c.query(
    `INSERT INTO agent_general_threads (tenant_id, user_id, titulo, turnos)
     VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
    [input.tenantId, input.userId, titulo, json],
  );
  return { id: r.rows[0].id as string };
}

/** Borra uno. Para cuando la persona quiere que no quede. */
export async function borrarHilo(
  c: PoolClient,
  input: { tenantId: string; userId: string; id: string },
): Promise<boolean> {
  const r = await c.query(
    'DELETE FROM agent_general_threads WHERE tenant_id = $1 AND user_id = $2 AND id = $3',
    [input.tenantId, input.userId, input.id],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * La purga por retención. La corre el barrido, no una petición.
 *
 * Sin `tenant_id`: borra en todos, y por eso tiene que correr con el rol que
 * puede —el mismo criterio que el resto de los barridos del repo.
 */
export async function purgarHilosViejos(c: PoolClient, dias = DIAS_DE_RETENCION): Promise<number> {
  const r = await c.query(
    `DELETE FROM agent_general_threads WHERE updated_at < now() - ($1 || ' days')::interval`,
    [String(dias)],
  );
  return r.rowCount ?? 0;
}
