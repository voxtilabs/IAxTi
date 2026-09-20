import type { PoolClient } from 'pg';
import { publishEvent } from '@iaxti/core';
import { zonaDelTenant } from '@iaxti/module-organizations';
import { writeAudit, type ActorKind } from '@iaxti/module-audit';
import { assertTransicionCita, ocupaAgenda, type EstadoCita } from '../domain/estado';
import { huecosLibres, comoHora, type Ocupado } from '../domain/horarios';

/**
 * La agenda (SPEC §16): disponibilidad configurada, huecos reales y citas.
 *
 * Todo lo que tiene hora se calcula en la zona del NEGOCIO, no en la del
 * servidor. Para una pyme de Arica y otra de Punta Arenas "las 9" es la
 * misma hora en la pantalla y dos instantes distintos en la base; hacerlo
 * al revés es el error que no se nota hasta que un cliente llega a la hora
 * equivocada.
 */

export interface Disponibilidad {
  id: string;
  ownerId: string;
  weekday: number;
  inicio: string;
  fin: string;
  duracion: number;
  respiro: number;
  anticipacion: number;
}

export async function definirDisponibilidad(
  client: PoolClient,
  input: {
    tenantId: string;
    ownerId: string;
    weekday: number;
    inicioMin: number;
    finMin: number;
    duracion?: number;
    respiro?: number;
    anticipacionMin?: number;
  },
): Promise<Disponibilidad> {
  if (input.finMin <= input.inicioMin) {
    throw new Error('La hora de cierre tiene que ser después de la de apertura.');
  }
  const r = await client.query(
    `INSERT INTO availability
       (tenant_id, owner_id, weekday, start_minute, end_minute, slot_minutes, buffer_minutes, min_notice_minutes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [
      input.tenantId,
      input.ownerId,
      input.weekday,
      input.inicioMin,
      input.finMin,
      input.duracion ?? 30,
      input.respiro ?? 0,
      input.anticipacionMin ?? 60,
    ],
  );
  const f = r.rows[0];
  return {
    id: f.id,
    ownerId: f.owner_id,
    weekday: f.weekday,
    inicio: comoHora(f.start_minute),
    fin: comoHora(f.end_minute),
    duracion: f.slot_minutes,
    respiro: f.buffer_minutes,
    anticipacion: f.min_notice_minutes,
  };
}

export interface HuecoOfrecido {
  inicio: Date;
  fin: Date;
  hora: string;
  ownerId: string;
}

/**
 * Los horarios que se le pueden ofrecer a alguien para un día.
 *
 * `ahora` entra por parámetro y no se lee del reloj adentro: así el test
 * puede pararse en un instante y este cálculo es reproducible. La
 * anticipación mínima se mide contra ese instante.
 */
export async function huecosDelDia(
  client: PoolClient,
  input: {
    tenantId: string;
    ownerId: string;
    dia: string;
    ahora?: Date;
    /**
     * Lo que la persona tiene ocupado FUERA de IAxTi, en minutos locales
     * del día (#57).
     *
     * Acá es donde enchufa el free/busy de Google: el criterio del issue
     * es «huecos = free/busy real ∩ disponibilidad configurada», y esta es
     * la mitad que faltaba. Sin esto, la agenda ofrece horas en las que la
     * persona ya tiene una reunión en su calendario personal — que es peor
     * que no ofrecer nada, porque el cliente ya reservó.
     *
     * Entran DATOS y no un cliente de Google a propósito: este módulo no
     * conoce proveedores. Quien tenga el token los trae y los pasa, igual
     * que el worker pasa `enviar` a los recordatorios.
     *
     * Sin esto, se comporta como antes: solo nuestras citas.
     */
    ocupadoExterno?: Ocupado[];
  },
): Promise<HuecoOfrecido[]> {
  const zona = await zonaDelTenant(client, input.tenantId);
  const ahora = input.ahora ?? new Date();

  // El día de la semana se pregunta en la zona del negocio: a las 23:00 en
  // Chile ya es otro día en UTC, y ahí la agenda ofrecería el día que no es.
  const dow = await client.query(
    `SELECT EXTRACT(dow FROM ($1::date))::int AS dow`,
    [input.dia],
  );
  const weekday = dow.rows[0].dow as number;

  const disp = await client.query(
    `SELECT * FROM availability
      WHERE tenant_id = $1 AND owner_id = $2 AND weekday = $3
      ORDER BY start_minute`,
    [input.tenantId, input.ownerId, weekday],
  );
  if (disp.rowCount === 0) return [];

  // Lo que ya está tomado ese día, en minutos locales.
  const citas = await client.query(
    `SELECT
       (EXTRACT(hour FROM starts_at AT TIME ZONE $4) * 60
        + EXTRACT(minute FROM starts_at AT TIME ZONE $4))::int AS inicio,
       (EXTRACT(hour FROM ends_at AT TIME ZONE $4) * 60
        + EXTRACT(minute FROM ends_at AT TIME ZONE $4))::int AS fin
       FROM appointments
      WHERE tenant_id = $1 AND owner_id = $2
        AND (starts_at AT TIME ZONE $4)::date = $3::date
        AND status IN ('proposed','confirmed','reminded')`,
    [input.tenantId, input.ownerId, input.dia, zona],
  );
  const ocupados: Ocupado[] = [
    ...citas.rows.map((c) => ({ inicio: c.inicio, fin: c.fin })),
    // Lo de afuera pesa igual que lo nuestro: una reunión en el calendario
    // personal ocupa la hora aunque no la hayamos creado nosotros.
    ...(input.ocupadoExterno ?? []),
  ];

  const salida: HuecoOfrecido[] = [];
  for (const d of disp.rows) {
    const libres = huecosLibres(
      {
        inicio: d.start_minute,
        fin: d.end_minute,
        duracion: d.slot_minutes,
        respiro: d.buffer_minutes,
      },
      ocupados,
    );
    for (const minuto of libres) {
      // El instante real de ese minuto local, resuelto por Postgres con la
      // zona del negocio: hacerlo a mano es donde se cuelan los cambios de
      // horario de verano.
      const r = await client.query(
        `SELECT (($1::date + make_interval(mins => $2)) AT TIME ZONE $3) AS inicio,
                (($1::date + make_interval(mins => $2 + $4)) AT TIME ZONE $3) AS fin`,
        [input.dia, minuto, zona, d.slot_minutes],
      );
      const inicio = r.rows[0].inicio as Date;
      // La anticipación mínima: una hora para dentro de diez minutos no le
      // sirve a nadie, y ofrecerla hace quedar mal al negocio.
      if (inicio.getTime() - ahora.getTime() < d.min_notice_minutes * 60_000) continue;
      salida.push({
        inicio,
        fin: r.rows[0].fin as Date,
        hora: comoHora(minuto),
        ownerId: input.ownerId,
      });
    }
  }
  return salida.sort((a, b) => a.inicio.getTime() - b.inicio.getTime());
}

export interface Cita {
  id: string;
  contactId: string;
  ownerId: string;
  startsAt: Date;
  endsAt: Date;
  status: EstadoCita;
  title: string | null;
}

function aCita(row: Record<string, unknown>): Cita {
  return {
    id: row.id as string,
    contactId: row.contact_id as string,
    ownerId: row.owner_id as string,
    startsAt: row.starts_at as Date,
    endsAt: row.ends_at as Date,
    status: row.status as EstadoCita,
    title: (row.title as string) ?? null,
  };
}

/**
 * Agenda una cita. Dos citas no pueden ocupar el mismo lugar: se comprueba
 * ACÁ, contra lo que hay en la base, y no contra los huecos que se
 * ofrecieron hace un minuto — entre que la IA ofrece tres horarios y la
 * persona elige uno, alguien más pudo tomar el mismo.
 */
export async function agendar(
  client: PoolClient,
  input: {
    tenantId: string;
    contactId: string;
    ownerId: string;
    inicio: Date;
    fin: Date;
    title?: string;
    conversationId?: string;
    dealId?: string;
    confirmada?: boolean;
    actor?: string;
    actorKind?: ActorKind;
    requestId?: string;
  },
): Promise<Cita> {
  if (!Number.isFinite(input.inicio.getTime()) || !Number.isFinite(input.fin.getTime())) {
    throw new Error('Las fechas de la cita no se entienden. Revisa el inicio y el fin.');
  }
  if (input.fin.getTime() <= input.inicio.getTime()) {
    throw new Error('La cita tiene que terminar después de empezar.');
  }
  // Dos SELECT sin bloqueo pueden ver libre la misma hora. El lock vive
  // hasta el commit/rollback de withTenant y solo compite por esta agenda.
  // Hash de 64 bits con namespace; no necesita extensión ni migración.
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended(
       'calendar:agenda:' || $1::uuid::text || ':' || $2::uuid::text, 0))`,
    [input.tenantId, input.ownerId],
  );
  const choca = await client.query(
    `SELECT id FROM appointments
      WHERE tenant_id = $1 AND owner_id = $2
        AND status IN ('proposed','confirmed','reminded')
        AND starts_at < $4 AND ends_at > $3
      LIMIT 1`,
    [input.tenantId, input.ownerId, input.inicio, input.fin],
  );
  if ((choca.rowCount ?? 0) > 0) {
    throw new Error('Esa hora se acaba de tomar. Ofrécele otra.');
  }

  const r = await client.query(
    `INSERT INTO appointments
       (tenant_id, contact_id, owner_id, conversation_id, deal_id, title, starts_at, ends_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [
      input.tenantId,
      input.contactId,
      input.ownerId,
      input.conversationId ?? null,
      input.dealId ?? null,
      input.title ?? null,
      input.inicio,
      input.fin,
      input.confirmada ? 'confirmed' : 'proposed',
    ],
  );
  const cita = aCita(r.rows[0]);
  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: input.actor ?? 'system',
    actorKind: input.actorKind ?? (input.actor && input.actor !== 'system' ? 'user' : 'system'),
    action: 'calendar.appointment.created', resource: 'appointment', resourceId: cita.id,
    result: 'success', requestId: input.requestId,
    metadata: { ownerId: input.ownerId, startsAt: cita.startsAt, endsAt: cita.endsAt, status: cita.status },
  });
  await publishEvent(client, {
    name: 'appointment.created',
    tenantId: input.tenantId,
    payload: {
      appointmentId: cita.id,
      contactId: cita.contactId,
      startsAt: cita.startsAt,
      status: cita.status,
    },
    actor: input.actor ?? 'system',
    requestId: input.requestId,
  });
  return cita;
}

/** Cambia el estado con la máquina del dominio y avisa lo que corresponde. */
export async function cambiarEstadoCita(
  client: PoolClient,
  input: {
    tenantId: string;
    appointmentId: string;
    to: EstadoCita;
    motivo?: string;
    actor?: string;
    actorKind?: ActorKind;
    requestId?: string;
  },
): Promise<Cita> {
  const actual = await client.query(
    'SELECT * FROM appointments WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
    [input.tenantId, input.appointmentId],
  );
  if (actual.rowCount === 0) throw new Error('Esa cita no existe en este negocio.');
  const antes = aCita(actual.rows[0]);
  assertTransicionCita(antes.status, input.to);

  const r = await client.query(
    `UPDATE appointments SET status = $3, cancel_reason = COALESCE($4, cancel_reason), updated_at = now()
      WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [input.tenantId, input.appointmentId, input.to, input.motivo ?? null],
  );

  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: input.actor ?? 'system',
    actorKind: input.actorKind ?? (input.actor && input.actor !== 'system' ? 'user' : 'system'),
    action: 'calendar.appointment.state_changed', resource: 'appointment', resourceId: input.appointmentId,
    result: 'success', requestId: input.requestId,
    metadata: { from: antes.status, to: input.to },
  });

  const evento: Partial<Record<EstadoCita, string>> = {
    attended: 'appointment.attended',
    no_show: 'appointment.no_show',
    cancelled: 'appointment.cancelled',
  };
  const name = evento[input.to];
  if (name) {
    await publishEvent(client, {
      name,
      tenantId: input.tenantId,
      payload: {
        appointmentId: input.appointmentId,
        contactId: antes.contactId,
        startsAt: antes.startsAt,
        motivo: input.motivo ?? null,
      },
      actor: input.actor ?? 'system',
      requestId: input.requestId,
    });
  }
  return aCita(r.rows[0]);
}

/** La agenda de alguien entre dos fechas, para la pantalla. */
export async function listarCitas(
  client: PoolClient,
  input: { tenantId: string; ownerId?: string; desde: Date; hasta: Date },
): Promise<Cita[]> {
  const r = await client.query(
    `SELECT * FROM appointments
      WHERE tenant_id = $1 AND starts_at >= $2 AND starts_at < $3
        AND ($4::uuid IS NULL OR owner_id = $4)
      ORDER BY starts_at`,
    [input.tenantId, input.desde, input.hasta, input.ownerId ?? null],
  );
  return r.rows.map(aCita);
}

export { ocupaAgenda };
