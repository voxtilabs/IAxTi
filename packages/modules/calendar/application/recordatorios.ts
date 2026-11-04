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
/**
 * Deja escrito por qué no salió el aviso, y devuelve la cita a `confirmed`
 * (#1250).
 *
 * Va en su propia función y no dentro de `tick` para que se pueda probar
 * sola, y escribe el motivo tal como lo dio quien envía: ese texto ya está
 * redactado para que lo lea el dueño («este contacto no tiene conversación por
 * dónde avisarle»), no es un error de servidor.
 */
export async function guardarElMotivo(
  client: PoolClient,
  input: { tenantId: string; appointmentId: string; motivo: string },
): Promise<void> {
  await client.query(
    `UPDATE appointments
        SET aviso_error = $3,
            status = CASE WHEN status = 'reminded' THEN 'confirmed' ELSE status END,
            updated_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.appointmentId, input.motivo],
  );
}

export async function marcarAvisoEnviado(
  client: PoolClient,
  input: { tenantId: string; appointmentId: string; aviso: AvisoId; requestId?: string },
): Promise<boolean> {
  const r = await client.query(
    `UPDATE appointments
        SET reminders_sent = reminders_sent || to_jsonb($3::text),
            status = CASE WHEN status = 'confirmed' THEN 'reminded' ELSE status END,
            aviso_error = NULL,
            updated_at = now()
      WHERE tenant_id = $1 AND id = $2 AND NOT (reminders_sent ? $3)
      RETURNING id`,
    [input.tenantId, input.appointmentId, input.aviso],
  );
  if (r.rowCount === 0) return false; // ya estaba marcado: alguien se adelantó
  // Un intento nuevo borra el motivo del anterior: si no, un fallo de ayer
  // seguiría en pantalla sobre una cita a la que hoy sí se le avisó.

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
    /**
     * ¿Y ESTE negocio puede? (#59)
     *
     * `disponible` responde por el ambiente —si no hay llave del proveedor,
     * no se manda nada de nada—. Pero la plantilla del recordatorio es de
     * cada negocio: uno la tiene aprobada y el de al lado no.
     *
     * Sin esta pregunta, el negocio sin plantilla se llevaba sus citas a
     * `reminded` igual, porque el marcado va antes del envío. Y `reminded`
     * es un estado que una persona lee como "al cliente ya se le avisó".
     */
    disponibleParaTenant?: (tenantId: string) => Promise<boolean> | boolean;
    ahora?: Date;
  },
): Promise<{ enviados: number; saltados: number; sinConfigurar: number; motivo?: string }> {
  const ahora = deps.ahora ?? new Date();

  if (deps.disponible && !(await deps.disponible())) {
    // No se toca nada: las citas siguen esperando su recordatorio para
    // cuando haya con qué mandarlo.
    return { enviados: 0, saltados: 0, sinConfigurar: 0, motivo: 'no hay por dónde mandar el recordatorio' };
  }
  // A QUIÉN visitar se pregunta UNA vez (#733, ADR-0026).
  //
  // Antes se recorrían todos los tenants vivos y, por cada uno, se corría una
  // consulta por cada aviso de `AVISOS` para descubrir que no tiene citas.
  // Medido con 1.283 tenants: 4,5 ms cada uno, ~5,8 s el barrido entero — y
  // este barrido corre cada pocos minutos, no una vez al día.
  //
  // `appointments` tiene RLS, así que la pregunta vive en una función SECURITY
  // DEFINER que devuelve SOLO ids (#286 sigue en pie: una consulta suelta a
  // `appointments` devolvería cero filas con el rol de producción). Cada tenant
  // se sigue visitando con `withTenant`, y qué aviso corresponde lo decide
  // `citasPorRecordar` con `AVISOS` — la función no evalúa la regla, solo filtra
  // a quién mirar.
  // El MISMO instante con el que después se evalúa. Si el filtro usara `now()`
  // y el barrido un reloj inyectado, discreparían: el barrido no vería al
  // tenant que sí tenía una cita para su reloj. Lo cazó una prueba.
  const conCitas = (
    await pool.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM tenants_con_citas_por_recordar($1::timestamptz)',
      [ahora],
    )
  ).rows.map((f) => f.tenant_id);
  let enviados = 0;
  let saltados = 0;
  let sinConfigurar = 0;
  await porCadaTenant(pool, async (client, tenantId) => {
    {
      const pendientes = await citasPorRecordar(client, { tenantId, ahora });
      if (pendientes.length === 0) return;
      // La pregunta por tenant se hace UNA vez y solo si hay algo que
      // mandar: consultar la configuración de cada negocio en cada barrido,
      // tenga o no citas, es trabajo que crece con la cartera y no sirve
      // para nada.
      if (deps.disponibleParaTenant && !(await deps.disponibleParaTenant(tenantId))) {
        sinConfigurar += pendientes.length;
        return;
      }
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
        if (res.enviado) {
          enviados += 1;
          continue;
        }
        saltados += 1;
        /**
         * El fallo deja rastro EN LA CITA (#1250).
         *
         * Antes solo se contaba. El aviso quedaba consumido y la cita en
         * `reminded`, así que la pantalla decía «Avisada» sobre alguien a
         * quien no le llegó nada: un silencio convertido en mentira, que es
         * peor que el silencio.
         *
         * El estado se devuelve a `confirmed` porque `reminded` significa
         * «se le avisó» y no se le avisó. El aviso SÍ queda consumido —no se
         * deshace— para no reintentar en bucle un fallo que no se va a
         * arreglar solo: quien lo arregla es una persona, y para eso necesita
         * ver el motivo.
         */
        await guardarElMotivo(client, {
          tenantId: cita.tenantId,
          appointmentId: cita.appointmentId,
          motivo: res.motivo ?? 'no se pudo enviar y nadie dijo por qué',
        });
      }
    }
  }, { ids: conCitas });
  return { enviados, saltados, sinConfigurar };
}
