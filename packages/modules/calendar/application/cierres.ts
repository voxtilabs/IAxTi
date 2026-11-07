import type { PoolClient } from 'pg';
import { diaEn } from '@iaxti/core';
import { zonaDelTenant } from '@iaxti/module-organizations';
import { writeAudit, type ActorKind } from '@iaxti/module-audit';

/**
 * Los días que el negocio no abre (#1281).
 *
 * `availability` guarda el horario por día de la semana, así que un feriado o
 * una semana de vacaciones no tenían dónde ir. El 18 de septiembre de 2026 cae
 * viernes: una barbería que atiende los viernes ofrecía y confirmaba horas
 * para ese día, y el cliente llegaba a la puerta cerrada con una confirmación
 * de WhatsApp en la mano. Con el agente tomando horas solo (ADR-0029) eso
 * dejó de ser hipotético.
 *
 * Un cierre es un rango de FECHAS locales del negocio, inclusive en los dos
 * extremos, de una persona del equipo o de todo el negocio. No es un tramo
 * horario: cerrar medio día es otra cosa y queda fuera a propósito.
 */

export interface Cierre {
  id: string;
  /** `null` = todo el negocio. */
  ownerId: string | null;
  /** `YYYY-MM-DD`, fecha local del negocio. */
  desde: string;
  hasta: string;
  motivo: string | null;
  creadoPor: string | null;
  creadoEn: string;
}

/**
 * Las fechas viajan como TEXTO desde Postgres, y no es un detalle.
 *
 * `node-postgres` parsea un `date` como un `Date` a medianoche de la zona del
 * proceso. Pasarlo por `toISOString().slice(0, 10)` devuelve el día correcto
 * en Chile —UTC-4, la medianoche local es la madrugada UTC del mismo día— y
 * el día ANTERIOR en cualquier zona positiva: en UTC+2, el 11 de junio a las
 * 00:00 es el 10 a las 22:00Z. El defecto esperaba un contenedor con TZ
 * positiva, y mis pruebas pasaban porque el mío no la tiene.
 *
 * Con `::text` el día que sale es el día que se guardó, en cualquier máquina.
 */
const COLUMNAS =
  'id, owner_id, starts_on::text AS starts_on, ends_on::text AS ends_on, motivo, created_by, created_at';

function aCierre(row: Record<string, unknown>): Cierre {
  return {
    id: row.id as string,
    ownerId: (row.owner_id as string | null) ?? null,
    desde: row.starts_on as string,
    hasta: row.ends_on as string,
    motivo: (row.motivo as string | null) ?? null,
    creadoPor: (row.created_by as string | null) ?? null,
    creadoEn: (row.created_at as Date).toISOString(),
  };
}

/**
 * ¿Está cerrado este día?
 *
 * Mira los cierres de esta persona Y los del negocio completo: un feriado
 * cierra para todos, y las vacaciones de alguien cierran solo su agenda.
 *
 * Lo consulta `huecosDelDia` en cada corrida, que es el único lugar donde la
 * disponibilidad se calcula: cerrar un día tiene que apagar el cálculo, no
 * agregar una comprobación más que alguien se olvide de hacer.
 */
export async function diaCerrado(
  client: PoolClient,
  input: { tenantId: string; ownerId: string; dia: string },
): Promise<Cierre | null> {
  const r = await client.query(
    `SELECT ${COLUMNAS} FROM time_off
      WHERE tenant_id = $1
        AND (owner_id IS NULL OR owner_id = $2)
        AND $3::date BETWEEN starts_on AND ends_on
      -- El del negocio manda sobre el de la persona: si los dos aplican, el
      -- motivo que el dueño quiere leer es «feriado», no «vacaciones de Ana».
      ORDER BY owner_id NULLS FIRST
      LIMIT 1`,
    [input.tenantId, input.ownerId, input.dia],
  );
  return r.rowCount === 0 ? null : aCierre(r.rows[0]);
}

/**
 * Un cierre por su id.
 *
 * Existe para que la ruta pueda AUTORIZAR el borrado: quien no administra el
 * equipo solo reabre sus propios días, y para saber de quién es el cierre hay
 * que leerlo antes de borrarlo.
 */
export async function cierrePorId(
  client: PoolClient,
  input: { tenantId: string; cierreId: string },
): Promise<Cierre | null> {
  const r = await client.query(`SELECT ${COLUMNAS} FROM time_off WHERE tenant_id = $1 AND id = $2`, [
    input.tenantId,
    input.cierreId,
  ]);
  return r.rowCount === 0 ? null : aCierre(r.rows[0]);
}

export async function cerrarDias(
  client: PoolClient,
  input: {
    tenantId: string;
    /** `null` o ausente = todo el negocio. */
    ownerId?: string | null;
    desde: string;
    hasta?: string;
    motivo?: string | null;
    actor?: string;
    actorKind?: ActorKind;
    requestId?: string;
  },
): Promise<Cierre> {
  const hasta = input.hasta ?? input.desde;
  if (hasta < input.desde) {
    throw new Error('El cierre termina antes de empezar. Revisa las fechas.');
  }
  const r = await client.query(
    `INSERT INTO time_off (tenant_id, owner_id, starts_on, ends_on, motivo, created_by)
     VALUES ($1, $2, $3::date, $4::date, $5, $6)
     RETURNING ${COLUMNAS}`,
    [
      input.tenantId,
      input.ownerId ?? null,
      input.desde,
      hasta,
      input.motivo ?? null,
      input.actor ?? null,
    ],
  );
  const cierre = aCierre(r.rows[0]);
  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: input.actor ?? 'system',
    actorKind: input.actorKind ?? (input.actor && input.actor !== 'system' ? 'user' : 'system'),
    action: 'calendar.time_off.created',
    resource: 'time_off',
    resourceId: cierre.id,
    result: 'success',
    requestId: input.requestId,
    metadata: {
      ownerId: cierre.ownerId,
      desde: cierre.desde,
      hasta: cierre.hasta,
      motivo: cierre.motivo,
    },
  });
  return cierre;
}

/**
 * Los cierres vigentes y los que vienen.
 *
 * Por omisión oculta lo pasado: la pantalla del dueño muestra lo que va a
 * pasar, no el historial de feriados de los últimos tres años.
 *
 * El día de corte se calcula ACÁ, con la zona del negocio, y no en el
 * navegador. Calcularlo allá con `toISOString().slice(0, 10)` da UTC, y en
 * Chile a partir de las 21:00 eso ya es mañana: un cierre de hoy desaparecía
 * de la lista justo la noche anterior al día que cierra.
 *
 * `ahora` se inyecta para que una prueba no dependa del reloj de la máquina.
 */
export async function listarCierres(
  client: PoolClient,
  input: {
    tenantId: string;
    ownerId?: string | null;
    desdeElDia?: string;
    incluirPasados?: boolean;
    ahora?: Date;
  },
): Promise<Cierre[]> {
  const corte = input.incluirPasados
    ? null
    : (input.desdeElDia ??
      diaEn(await zonaDelTenant(client, input.tenantId), input.ahora ?? new Date()));
  const r = await client.query(
    `SELECT ${COLUMNAS} FROM time_off
      WHERE tenant_id = $1
        AND ($2::uuid IS NULL OR owner_id IS NULL OR owner_id = $2)
        AND ($3::date IS NULL OR ends_on >= $3::date)
      ORDER BY starts_on, owner_id NULLS FIRST`,
    [input.tenantId, input.ownerId ?? null, corte],
  );
  return r.rows.map(aCierre);
}

/**
 * Reabrir: borra el cierre.
 *
 * Devuelve `false` si no existía, para que la ruta pueda responder 404 en vez
 * de un 200 que miente.
 */
export async function abrirDias(
  client: PoolClient,
  input: {
    tenantId: string;
    cierreId: string;
    actor?: string;
    actorKind?: ActorKind;
    requestId?: string;
  },
): Promise<boolean> {
  const r = await client.query(
    `DELETE FROM time_off WHERE tenant_id = $1 AND id = $2
     RETURNING ${COLUMNAS}`,
    [input.tenantId, input.cierreId],
  );
  if (r.rowCount === 0) return false;
  const cierre = aCierre(r.rows[0]);
  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: input.actor ?? 'system',
    actorKind: input.actorKind ?? (input.actor && input.actor !== 'system' ? 'user' : 'system'),
    action: 'calendar.time_off.deleted',
    resource: 'time_off',
    resourceId: cierre.id,
    result: 'success',
    requestId: input.requestId,
    metadata: { ownerId: cierre.ownerId, desde: cierre.desde, hasta: cierre.hasta },
  });
  return true;
}
