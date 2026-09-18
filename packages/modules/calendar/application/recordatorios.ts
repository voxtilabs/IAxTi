import type { Pool, PoolClient } from 'pg';
import { publishEvent } from '@iaxti/core';
import { porCadaTenant } from '@iaxti/db';

/**
 * Recordatorios de cita (SPEC §16, #59).
 *
 * "La cita que no se recuerda no se asiste" — y para una pyme un no-show es
 * una hora que no se cobra y no se recupera.
 *
 * Salen 24 h y 2 h antes, por plantilla aprobada: a esa altura la
 * conversación casi siempre está fuera de la ventana de 24 h, que es
 * exactamente para lo que existen las plantillas (#44).
 *
 * El horario de silencio NO se maneja acá: el recordatorio va a la cola de
 * salida marcado como iniciado por el negocio, y la cola lo difiere sola
 * (#43). Repetir esa lógica sería tener dos sitios donde arreglarla.
 */

export const AVISOS = [
  { id: '24h', minutosAntes: 24 * 60 },
  { id: '2h', minutosAntes: 2 * 60 },
] as const;

export type AvisoId = (typeof AVISOS)[number]['id'];

export interface CitaPorRecordar {
  appointmentId: string;
  tenantId: string;
  contactId: string;
  conversationId: string | null;
  startsAt: Date;
  aviso: AvisoId;
}

/**
 * Las citas a las que les toca un recordatorio AHORA.
 *
 * La ventana es de una hora hacia atrás: si el barrido se cae y se levanta
 * cuarenta minutos después, el recordatorio igual sale. Más atrás no, porque
 * un "te recuerdo tu hora" que llega tarde es peor que ninguno.
 */
export async function citasPorRecordar(
  client: PoolClient,
  input: { tenantId: string; ahora?: Date },
): Promise<CitaPorRecordar[]> {
  const ahora = input.ahora ?? new Date();
  const salida: CitaPorRecordar[] = [];

  for (const aviso of AVISOS) {
    const r = await client.query(
      `SELECT id, contact_id, conversation_id, starts_at
         FROM appointments
        WHERE tenant_id = $1
          AND status IN ('confirmed','reminded')
          AND starts_at > $2
          AND starts_at <= $2 + make_interval(mins => $3)
          AND starts_at > $2 + make_interval(mins => $3 - 60)
          AND NOT (reminders_sent ? $4)
        ORDER BY starts_at`,
      [input.tenantId, ahora, aviso.minutosAntes, aviso.id],
    );
    for (const fila of r.rows) {
      salida.push({
        appointmentId: fila.id,
        tenantId: input.tenantId,
        contactId: fila.contact_id,
        conversationId: fila.conversation_id ?? null,
        startsAt: fila.starts_at,
        aviso: aviso.id,
      });
    }
  }
  return salida;
}

/**
 * Marca el aviso como mandado. Se hace ANTES de encolar y no después: si el
 * encolado falla, el peor caso es un recordatorio que no salió — y el peor
 * caso del orden inverso es mandarlo tres veces, que es de las cosas que
 * hacen que alguien bloquee un número.
 */
export async function marcarAvisoEnviado(
  client: PoolClient,
  input: { tenantId: string; appointmentId: string; aviso: AvisoId; requestId?: string },
): Promise<boolean> {
  const r = await client.query(
    `UPDATE appointments
        SET reminders_sent = reminders_sent || to_jsonb($3::text),
            status = CASE WHEN status = 'confirmed' THEN 'reminded' ELSE status END,
            updated_at = now()
      WHERE tenant_id = $1 AND id = $2 AND NOT (reminders_sent ? $3)
      RETURNING id`,
    [input.tenantId, input.appointmentId, input.aviso],
  );
  if (r.rowCount === 0) return false; // ya estaba marcado: alguien se adelantó

  await publishEvent(client, {
    name: 'appointment.reminder_sent',
    tenantId: input.tenantId,
    payload: { appointmentId: input.appointmentId, aviso: input.aviso },
    actor: 'system',
    requestId: input.requestId,
  });
  return true;
}

/**
 * El barrido: mira todos los tenants con citas próximas y manda lo que toca.
 *
 * `enviar` lo pone quien tenga a mano la plantilla y la cola —el worker—,
 * así este módulo no depende de whatsapp y la agenda sigue funcionando con
 * el módulo de WhatsApp apagado (SPEC §16: degrada por capabilities).
 */
export async function barrerRecordatorios(
  pool: Pool,
  deps: {
    enviar: (cita: CitaPorRecordar) => Promise<{ enviado: boolean; motivo?: string }>;
    /**
     * ¿Se puede enviar algo, en general? No por cita: por ambiente.
     *
     * `marcarAvisoEnviado` marca ANTES de enviar, y eso está bien razonado:
     * el peor caso es un recordatorio perdido, y el del orden inverso es
     * mandarlo tres veces. Pero ese razonamiento supone que el envío PUEDE
     * salir. Cuando no hay plantilla aprobada ni número conectado, el envío
     * falla siempre — y entonces "de vez en cuando se pierde" se convierte
     * en "siempre, y en silencio", con la cita marcada `reminded`, que es
     * un estado que una persona lee como "al cliente ya se le avisó".
     *
     * Sin esta función se asume que sí se puede: el comportamiento de antes
     * para quien ya tenía un emisor de verdad conectado.
     */
    disponible?: () => Promise<boolean> | boolean;
    ahora?: Date;
  },
): Promise<{ enviados: number; saltados: number; motivo?: string }> {
  const ahora = deps.ahora ?? new Date();

  if (deps.disponible && !(await deps.disponible())) {
    // No se toca nada: las citas siguen esperando su recordatorio para
    // cuando haya con qué mandarlo.
    return { enviados: 0, saltados: 0, motivo: 'no hay por dónde mandar el recordatorio' };
  }
  // Los tenants salen de `tenants`, no de `appointments` (#286): una
  // consulta suelta a una tabla con RLS corre sin `app.tenant_id` y devuelve
  // cero filas con el rol de producción. En desarrollo se veía bien porque
  // el rol es superusuario.
  let enviados = 0;
  let saltados = 0;
  await porCadaTenant(pool, async (client, tenantId) => {
    {
      const pendientes = await citasPorRecordar(client, { tenantId, ahora });
      for (const cita of pendientes) {
        // Marcar primero: ver el comentario de `marcarAvisoEnviado`.
        const primero = await marcarAvisoEnviado(client, {
          tenantId: cita.tenantId,
          appointmentId: cita.appointmentId,
          aviso: cita.aviso,
        });
        if (!primero) continue;
        const res = await deps.enviar(cita).catch((err: Error) => ({
          enviado: false,
          motivo: err.message,
        }));
        if (res.enviado) enviados += 1;
        else saltados += 1;
      }
    }
  });
  return { enviados, saltados };
}
