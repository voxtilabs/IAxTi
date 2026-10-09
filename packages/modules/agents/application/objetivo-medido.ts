import type { PoolClient } from 'pg';
import type { Consumer, EventEnvelope } from '@iaxti/core';
import { DEFINICIONES, type Objetivo } from '../domain/objetivo';
import { enteroDeEntorno } from '@iaxti/core';

// ¿El agente logra su objetivo? (#319)
//
// Hasta acá se medía cuántas ejecuciones, cuántos tokens y cuánto costó. Nada
// de eso responde la pregunta que el dueño se hace: ¿esto me sirve?

/**
 * Cuánto tiempo después de que el agente trabajó una conversación se le puede
 * atribuir el resultado.
 *
 * Tres días, y el número tiene razón: una conversación de WhatsApp que va a
 * terminar en cita o en venta se resuelve en horas, a veces al otro día. Más
 * allá de eso, lo que pasó pasó por otra cosa —el dueño llamó, el cliente
 * volvió por su cuenta— y contarlo como mérito del agente es inflar el número.
 *
 * Es una ventana, no una verdad. Por eso lo que entra por acá queda marcado
 * como `asistida` y nunca se suma con lo que el agente hizo él mismo.
 */
export const VENTANA_ATRIBUCION_DIAS = enteroDeEntorno('AGENT_GOAL_WINDOW_DAYS', 3);

/** El evento de éxito → de qué campo del payload sale el id del resultado. */
const REFERENCIA: Record<string, string> = {
  'appointment.created': 'appointmentId',
  'deal.created': 'dealId',
  'deal.stage_changed': 'dealId',
  // `linkId` y no `paymentId`: el payload de `payment.received` trae linkId,
  // amountClp, conversationId, dealId y contactId — no hay ningún paymentId.
  // Así que renombrar el evento sin cambiar esta llave habría dejado el
  // objetivo roto de una forma más difícil de ver (#544).
  'payment.received': 'linkId',
};

/** Todos los eventos que pueden cerrar un intento, sacados del catálogo. */
export function eventosDeExito(): string[] {
  const todos = new Set<string>();
  for (const def of Object.values(DEFINICIONES)) {
    for (const e of def.eventoDeExito) todos.add(e);
  }
  return [...todos];
}

/**
 * Abre el intento cuando el agente actúa por primera vez en la conversación.
 *
 * Idempotente: la segunda vez no pisa nada. Lo que importa es CUÁNDO empezó a
 * trabajarla, y eso es la primera vez, no la última.
 */
export async function abrirIntento(
  client: PoolClient,
  input: {
    tenantId: string;
    conversationId: string;
    contactId: string;
    agentId: string;
    objetivo: Objetivo;
    objetivoDetalle?: string | null;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO agent_goal_attempts
       (tenant_id, conversation_id, agent_id, objetivo, objetivo_detalle, contact_id)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (tenant_id, conversation_id) DO NOTHING`,
    [
      input.tenantId,
      input.conversationId,
      input.agentId,
      input.objetivo,
      input.objetivoDetalle ?? null,
      input.contactId,
    ],
  );
}

/**
 * El agente lo logró ÉL: ejecutó la tool que produjo el resultado.
 *
 * Esto no se infiere de nada — se llama desde la ejecución de la herramienta,
 * en su misma transacción, y sabe exactamente de qué conversación viene. Por
 * eso no necesita ventana ni cruce por contacto: es un hecho.
 *
 * Corre ANTES que el evento de éxito que la misma operación publica. Cuando
 * ese evento llegue, el intento ya no está pendiente y el consumidor no lo
 * toca: el orden no importa y no hay doble conteo.
 *
 * Estampa `closed_at` además de `achieved_at` (#701). Se escribía SOLO al
 * perder, así que un intento logrado quedaba con esa columna en NULL para
 * siempre: «cuánto tarda en lograrse» no se podía calcular, y por esa columna
 * un logro se veía igual que un intento todavía abierto.
 */
export async function marcarLogradoPorElAgente(
  client: PoolClient,
  input: {
    tenantId: string;
    conversationId: string;
    evento: string;
    referencia: string | null;
  },
): Promise<boolean> {
  const r = await client.query(
    `UPDATE agent_goal_attempts
        SET outcome = 'logrado',
            atribucion = 'agente',
            achieved_at = now(),
            achieved_event = $3,
            achieved_ref = $4,
            closed_at = now(),
            updated_at = now()
      WHERE tenant_id = $1 AND conversation_id = $2 AND outcome = 'pendiente'`,
    [input.tenantId, input.conversationId, input.evento, input.referencia],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Lo cerró una PERSONA después de que el agente trabajó la conversación.
 *
 * Acá sí hay inferencia, y por eso queda marcado distinto. Los eventos de
 * éxito traen `contactId` y no `conversationId`, así que lo único que se puede
 * decir es "este contacto consiguió esto, poco después de que el agente
 * hablara con él". Es un buen resultado y vale contarlo — pero no es lo mismo
 * que el agente haciéndolo, y sumarlos hace que el número mienta a favor
 * nuestro.
 */
export async function marcarLogrado(
  client: PoolClient,
  input: {
    tenantId: string;
    contactId: string;
    evento: string;
    referencia: string | null;
    ahora?: Date;
  },
): Promise<number> {
  const ahora = input.ahora ?? new Date();
  const desde = new Date(ahora.getTime() - VENTANA_ATRIBUCION_DIAS * 24 * 60 * 60 * 1000);
  // Solo intentos PENDIENTES cuyo objetivo declara este evento como éxito, del
  // mismo contacto y dentro de la ventana. Sin el filtro por objetivo, una
  // cita cerraría un intento de "vender" solo por ser del mismo contacto.
  const objetivosQueLoEsperan = Object.values(DEFINICIONES)
    .filter((d) => (d.eventoDeExito as readonly string[]).includes(input.evento))
    .map((d) => d.id);
  if (objetivosQueLoEsperan.length === 0) return 0;

  const r = await client.query(
    `UPDATE agent_goal_attempts
        SET outcome = 'logrado',
            atribucion = 'asistida',
            achieved_at = $5,
            achieved_event = $4,
            achieved_ref = $6,
            closed_at = $5,
            updated_at = now()
      WHERE tenant_id = $1
        AND contact_id = $2
        AND outcome = 'pendiente'
        AND objetivo = ANY($3::text[])
        AND started_at >= $7`,
    [
      input.tenantId,
      input.contactId,
      objetivosQueLoEsperan,
      input.evento,
      ahora,
      input.referencia,
      desde,
    ],
  );
  if ((r.rowCount ?? 0) > 0) return r.rowCount ?? 0;

  // No entró por la ventana. Anotarlo es lo que hace verificable la decisión
  // (#701): sin esto, «no contó» y «no pasó» se ven idénticos, y la pregunta
  // del dueño frente a un intento perdido de un cliente que terminó comprando
  // no tiene respuesta. La ventana NO se mueve: esto es poder verla.
  await client.query(
    `UPDATE agent_goal_attempts
        SET fuera_de_ventana_at = $4,
            fuera_de_ventana_event = $3,
            updated_at = now()
      WHERE tenant_id = $1
        AND contact_id = $2
        AND objetivo = ANY($5::text[])
        AND started_at < $6
        AND fuera_de_ventana_at IS NULL`,
    [
      input.tenantId,
      input.contactId,
      input.evento,
      ahora,
      objetivosQueLoEsperan,
      desde,
    ],
  );
  return 0;
}

/**
 * La conversación se cerró sin lograrlo: el intento se pierde.
 *
 * Sin esto el denominador sería solo lo que salió bien, y una tasa así no
 * significa nada: diría 100 % para siempre.
 */
export async function marcarPerdido(
  client: PoolClient,
  input: { tenantId: string; conversationId: string },
): Promise<boolean> {
  const r = await client.query(
    `UPDATE agent_goal_attempts
        SET outcome = 'perdido', closed_at = now(), updated_at = now()
      WHERE tenant_id = $1 AND conversation_id = $2 AND outcome = 'pendiente'`,
    [input.tenantId, input.conversationId],
  );
  return (r.rowCount ?? 0) > 0;
}

export interface TasaDeObjetivo {
  objetivo: Objetivo | null;
  /** Conversaciones que el agente trabajó y que ya terminaron (el denominador). */
  cerrados: number;
  pendientes: number;
  /** Lo logró el agente ejecutando la tool. Un hecho. */
  porElAgente: number;
  /** Lo cerró una persona después de que el agente trabajó. Una inferencia. */
  asistidos: number;
  perdidos: number;
  /** `porElAgente / cerrados`. La que se puede defender sin asteriscos. */
  tasaDelAgente: number | null;
  /** `(porElAgente + asistidos) / cerrados`. La otra. Van SIEMPRE separadas. */
  tasaConAsistencia: number | null;
  /**
   * Cuánto tarda en lograrse, en horas (#701).
   *
   * Sale de `closed_at − started_at` sobre los LOGRADOS, no de una resta contra
   * `now()`: restar contra ahora daría un número que crece solo con el tiempo
   * aunque no pase nada.
   *
   * `null` sin logros todavía. Como las tasas: «no se sabe» no es cero.
   */
  horasHastaElLogro: number | null;
  /**
   * Qué eventos contaron como logro, y cuántas veces cada uno (#701).
   *
   * `achieved_event` se escribía desde el primer día y nada lo leía, así que la
   * tasa era un número sin respaldo: no se podía mostrar «estos 14 se lograron,
   * y así». Y si el catálogo de eventos de éxito cambia, esto es lo único que
   * dice cuáles se midieron con la regla vieja.
   */
  porEvento: Array<{ evento: string; n: number }>;
  /**
   * Intentos donde el resultado llegó FUERA de la ventana de atribución.
   *
   * No suma a ninguna tasa: la ventana es una decisión y esto es poder verla.
   * Pero sin el número, «no contó» y «no pasó» se ven idénticos.
   */
  fueraDeVentana: number;
}

/**
 * Las dos tasas, nunca una sola.
 *
 * Mezclarlas exagera lo que hace el agente, y el valor entero de esta métrica
 * es que el dueño le crea. El día que descubra que le contamos como
 * "agendadas por la IA" las horas que tomó él a mano, deja de mirar el número
 * para siempre.
 */
export async function tasaDeObjetivo(
  client: PoolClient,
  tenantId: string,
  agentId: string,
): Promise<TasaDeObjetivo> {
  const r = await client.query(
    `SELECT objetivo,
            count(*) FILTER (WHERE outcome <> 'pendiente')                              AS cerrados,
            count(*) FILTER (WHERE outcome = 'pendiente')                               AS pendientes,
            count(*) FILTER (WHERE outcome = 'logrado' AND atribucion = 'agente')       AS por_el_agente,
            count(*) FILTER (WHERE outcome = 'logrado' AND atribucion = 'asistida')     AS asistidos,
            count(*) FILTER (WHERE outcome = 'perdido')                                 AS perdidos,
            count(*) FILTER (WHERE fuera_de_ventana_at IS NOT NULL)                     AS fuera_de_ventana,
            -- El tiempo hasta el logro sale de closed_at y no de now() (#701).
            avg(extract(epoch FROM (closed_at - started_at)))
              FILTER (WHERE outcome = 'logrado' AND closed_at IS NOT NULL)              AS segundos_al_logro
       FROM agent_goal_attempts
      WHERE tenant_id = $1 AND agent_id = $2
      GROUP BY objetivo
      ORDER BY count(*) DESC
      LIMIT 1`,
    [tenantId, agentId],
  );
  if (r.rowCount === 0) {
    return {
      objetivo: null,
      cerrados: 0,
      pendientes: 0,
      porElAgente: 0,
      asistidos: 0,
      perdidos: 0,
      tasaDelAgente: null,
      tasaConAsistencia: null,
      horasHastaElLogro: null,
      porEvento: [],
      fueraDeVentana: 0,
    };
  }
  const f = r.rows[0];
  const cerrados = Number(f.cerrados);
  const porElAgente = Number(f.por_el_agente);
  const asistidos = Number(f.asistidos);
  // Sin conversaciones terminadas no hay tasa. `null` y no `0`: "todavía no se
  // sabe" y "le va pésimo" son cosas distintas y se ven igual si se redondea.
  const tasa = (n: number) => (cerrados === 0 ? null : Math.round((n / cerrados) * 1000) / 1000);
  return {
    objetivo: f.objetivo as Objetivo,
    cerrados,
    pendientes: Number(f.pendientes),
    porElAgente,
    asistidos,
    perdidos: Number(f.perdidos),
    tasaDelAgente: tasa(porElAgente),
    tasaConAsistencia: tasa(porElAgente + asistidos),
    horasHastaElLogro:
      f.segundos_al_logro === null
        ? null
        : Math.round((Number(f.segundos_al_logro) / 3600) * 10) / 10,
    porEvento: await eventosQueLograron(client, tenantId, agentId),
    fueraDeVentana: Number(f.fuera_de_ventana),
  };
}

/** Qué eventos contaron como logro, con su cuenta, de mayor a menor. */
async function eventosQueLograron(
  client: PoolClient,
  tenantId: string,
  agentId: string,
): Promise<Array<{ evento: string; n: number }>> {
  const r = await client.query(
    `SELECT coalesce(achieved_event, 'sin registrar') AS evento, count(*)::int AS n
       FROM agent_goal_attempts
      WHERE tenant_id = $1 AND agent_id = $2 AND outcome = 'logrado'
      GROUP BY 1 ORDER BY n DESC, evento`,
    [tenantId, agentId],
  );
  return r.rows.map((f) => ({ evento: f.evento as string, n: f.n as number }));
}

export interface IntentoLogrado {
  conversationId: string;
  contactId: string;
  /** Qué evento contó como logro. `null` en intentos anteriores a #701. */
  evento: string | null;
  /** El id de la cita, el trato o el pago. */
  referencia: string | null;
  atribucion: 'agente' | 'asistida' | null;
  startedAt: Date;
  /** Cuándo se cerró. `null` en logros viejos que nunca lo estamparon. */
  closedAt: Date | null;
  /** Horas entre abrir el intento y cerrarlo. `null` si falta `closed_at`. */
  horas: number | null;
}

/**
 * Los intentos logrados, con el evento que los logró (#701).
 *
 * Criterio 1 del issue: la tasa tiene que poder mostrar su respaldo. «45 %» sin
 * poder abrir los catorce casos es un número que hay que creer; con el evento al
 * lado, es un número que se puede revisar — y esta métrica vale exactamente lo
 * que el dueño le crea.
 */
export async function intentosLogrados(
  client: PoolClient,
  tenantId: string,
  agentId: string,
  limite = 20,
): Promise<IntentoLogrado[]> {
  const tope = Math.min(Math.max(Math.trunc(Number(limite) || 20), 1), 100);
  const r = await client.query(
    `SELECT conversation_id, contact_id, achieved_event, achieved_ref, atribucion,
            started_at, closed_at,
            extract(epoch FROM (closed_at - started_at)) AS segundos
       FROM agent_goal_attempts
      WHERE tenant_id = $1 AND agent_id = $2 AND outcome = 'logrado'
      ORDER BY coalesce(closed_at, achieved_at, started_at) DESC
      LIMIT $3`,
    [tenantId, agentId, tope],
  );
  return r.rows.map((f) => ({
    conversationId: f.conversation_id as string,
    contactId: f.contact_id as string,
    evento: (f.achieved_event as string) ?? null,
    referencia: (f.achieved_ref as string) ?? null,
    atribucion: (f.atribucion as 'agente' | 'asistida') ?? null,
    startedAt: f.started_at as Date,
    closedAt: (f.closed_at as Date) ?? null,
    horas: f.segundos === null ? null : Math.round((Number(f.segundos) / 3600) * 10) / 10,
  }));
}

export interface CasiLogrado {
  conversationId: string;
  contactId: string;
  /** Qué evento llegó, tarde. */
  evento: string;
  cuando: Date;
  /** Cuántos días después de abrirse el intento. */
  diasDespues: number;
  /** En qué quedó el intento: perdido, o todavía abierto. */
  outcome: 'pendiente' | 'logrado' | 'perdido';
}

/**
 * Los que NO contaron por la ventana de atribución (#701, criterio 4).
 *
 * Sin esto, «no contó» y «no pasó» se ven idénticos, y el dueño que mira un
 * intento perdido de un cliente que terminó comprando no tiene respuesta. La
 * respuesta honesta no es «se perdió»: es «se perdió, y la venta llegó cinco
 * días después, fuera de los tres que atribuimos».
 *
 * No suma a ninguna tasa. La ventana es una decisión declarada
 * (`VENTANA_ATRIBUCION_DIAS`) y esto es poder verla, no moverla.
 */
export async function casiLogrados(
  client: PoolClient,
  tenantId: string,
  agentId: string,
  limite = 20,
): Promise<CasiLogrado[]> {
  const tope = Math.min(Math.max(Math.trunc(Number(limite) || 20), 1), 100);
  const r = await client.query(
    `SELECT conversation_id, contact_id, fuera_de_ventana_event, fuera_de_ventana_at,
            outcome,
            extract(epoch FROM (fuera_de_ventana_at - started_at)) / 86400 AS dias
       FROM agent_goal_attempts
      WHERE tenant_id = $1 AND agent_id = $2 AND fuera_de_ventana_at IS NOT NULL
      ORDER BY fuera_de_ventana_at DESC
      LIMIT $3`,
    [tenantId, agentId, tope],
  );
  return r.rows.map((f) => ({
    conversationId: f.conversation_id as string,
    contactId: f.contact_id as string,
    evento: f.fuera_de_ventana_event as string,
    cuando: f.fuera_de_ventana_at as Date,
    diasDespues: Math.round(Number(f.dias) * 10) / 10,
    outcome: f.outcome as CasiLogrado['outcome'],
  }));
}

/**
 * Los consumidores: los eventos de éxito cierran el intento; el cierre de la
 * conversación lo pierde.
 *
 * Idempotentes por construcción — el UPDATE filtra por `outcome = 'pendiente'`,
 * así que el mismo evento dos veces no cambia nada la segunda.
 */
export function objetivoConsumers(): Consumer[] {
  const deExito: Consumer[] = eventosDeExito().map((evento) => ({
    name: `agents.objetivo.${evento}`,
    moduleId: 'agents',
    event: evento,
    handler: async (envelope: EventEnvelope, client: PoolClient) => {
      const payload = (envelope.payload ?? {}) as Record<string, unknown>;
      const contactId = payload.contactId as string | undefined;
      // Sin contacto no hay a quién atribuirlo. Adivinar sería peor.
      if (!contactId) return;
      // Acá solo entra lo ASISTIDO. Lo que hizo el agente ya se marcó en la
      // transacción de la tool, así que ese intento no está pendiente y este
      // UPDATE no lo toca. No hay que preguntarle al `actor` quién fue: el
      // actor de una tool del agente es la PERSONA a cuyo nombre actúa, así
      // que mirarlo habría clasificado mal absolutamente todo.
      const campo = REFERENCIA[envelope.name];
      await marcarLogrado(client, {
        tenantId: envelope.tenantId,
        contactId,
        evento: envelope.name,
        referencia: campo ? ((payload[campo] as string) ?? null) : null,
      });
    },
  }));

  return [
    ...deExito,
    {
      name: 'agents.objetivo.conversation_cerrada',
      moduleId: 'agents',
      event: 'conversation.state_changed',
      handler: async (envelope: EventEnvelope, client: PoolClient) => {
        const payload = (envelope.payload ?? {}) as Record<string, unknown>;
        // `resolved` es el único estado terminal que existe: la tabla lo
        // limita a new/open/pending/resolved/snoozed. Escribí 'closed' de
        // memoria y no existe — habría sido una rama muerta que nunca
        // cierra un intento, y la tasa diría 100 % para siempre.
        if (String(payload.to ?? '') !== 'resolved') return;
        const conversationId = payload.conversationId as string | undefined;
        if (!conversationId) return;
        await marcarPerdido(client, { tenantId: envelope.tenantId, conversationId });
      },
    },
  ];
}
