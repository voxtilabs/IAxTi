import type { PoolClient } from 'pg';
import { publishEvent } from '@iaxti/core';
import { writeAudit, type ActorKind } from '@iaxti/module-audit';
import { quienesSon, quienFue, type Quien } from '@iaxti/module-identity';
import {
  contarSegmento,
  loteSiguienteDeCampana,
  previsualizarSegmento,
  type FiltrosSegmento,
} from './segmentos';

/**
 * Campañas: una plantilla aprobada a un segmento de la cartera (#75).
 *
 * Es la función que más rápido puede arruinarle la reputación a un negocio.
 * Tres decisiones cargan con eso:
 *
 *  1. **Vista previa obligatoria antes de mandar.** El conteo y la muestra
 *     salen de la MISMA consulta que después elige a quién se le manda: si
 *     fueran dos consultas distintas, la vista previa dejaría de significar
 *     algo.
 *  2. **Una fila por destinatario, con el motivo si no se le mandó.** Un
 *     "enviados: 120 de 200" sin decir qué pasó con los 80 obliga a
 *     adivinar, y lo que se adivina es siempre lo más cómodo.
 *  3. **La calidad del número manda.** En rojo no sale la campaña: mandarle
 *     promoción a mil personas desde un número que Meta ya está mirando es
 *     la forma más corta de perderlo.
 *
 * Lo que NO se decide acá, porque ya está decidido en la cola: el horario
 * de silencio, la pausa por calidad del envío individual y el estado del
 * tenant. La campaña marca cada mensaje como iniciado por el negocio y la
 * cola hace el resto.
 */

/**
 * Los valores de una campaña son PLANTILLAS de valor, no valores.
 *
 * `{{1}}` de una plantilla suele ser el nombre de quien lee — y ese cambia
 * en cada envío. Sin esto, una campaña con variables le manda el mismo
 * "Hola Ana" a toda la cartera, que es peor que no personalizar nada.
 *
 * Lo que no se puede resolver queda VACÍO y no rompe el envío: un mensaje
 * que dice "Hola," es feo; uno que no sale porque a alguien le falta el
 * nombre es plata perdida.
 */
export function resolverValores(
  valores: string[],
  contacto: { name?: string | null; phone?: string | null },
): string[] {
  const fuentes: Record<string, string> = {
    'contacto.nombre': (contacto.name ?? '').trim(),
    'contacto.telefono': (contacto.phone ?? '').trim(),
  };
  return valores.map((v) =>
    String(v ?? '').replace(/\{\s*(contacto\.[a-z_]+)\s*\}/gi, (_, clave) => fuentes[String(clave).toLowerCase()] ?? ''),
  );
}

export interface Campana {
  id: string;
  name: string;
  templateId: string;
  status: 'draft' | 'sending' | 'partial' | 'done' | 'cancelled';
  filters: FiltrosSegmento;
  values: string[];
  /**
   * Quién la lanzó (#697).
   *
   * `campaigns.created_by` se escribía desde el primer envío y ninguna pantalla
   * lo mostraba. «¿Quién mandó esto a 650 personas?» es la primera pregunta
   * cuando una campaña sale mal, y se contestaba abriendo Auditoría — con
   * permiso de auditoría, que el equipo no tiene.
   */
  creadaPor: Quien | null;
  /**
   * Cuántos eran al lanzar, congelado (#609).
   *
   * Los filtros ya se congelaban; el total no, y sin él «250 de 900» se mueve
   * solo: basta que entre un contacto nuevo al segmento mientras la campaña
   * sale para que el informe cambie hacia atrás.
   */
  plannedTotal: number | null;
  /** Por qué se detuvo, si no fue una persona: el tope del canal, el de 5.000. */
  stopReason: string | null;
  /** Quién pidió parar y cuándo (#610). */
  detenidaPor: Quien | null;
  stopRequestedAt: string | null;
}

function aCampana(row: Record<string, unknown>, quien?: Map<string, Quien>): Campana {
  return {
    id: row.id as string,
    name: row.name as string,
    templateId: row.template_id as string,
    status: row.status as Campana['status'],
    filters: (row.filters as FiltrosSegmento) ?? {},
    values: (row.values as string[]) ?? [],
    creadaPor: quienFue(quien, row.created_by),
    plannedTotal: (row.planned_total as number) ?? null,
    stopReason: (row.stop_reason as string) ?? null,
    detenidaPor: quienFue(quien, row.stopped_by),
    stopRequestedAt: row.stop_requested_at ? (row.stop_requested_at as Date).toISOString() : null,
  };
}

export async function crearCampana(
  client: PoolClient,
  input: {
    tenantId: string;
    name: string;
    templateId: string;
    filtros: FiltrosSegmento;
    valores?: string[];
    actor?: string;
    actorKind?: ActorKind;
    requestId?: string;
  },
  deps: {
    /** Cuántas variables pide la plantilla. Se comprueba ACÁ. */
    variablesDePlantilla?: (templateId: string) => Promise<number>;
  } = {},
): Promise<Campana> {
  const name = (input.name ?? '').trim();
  if (!name) throw new Error('La campaña necesita un nombre.');

  // Que los valores calcen con la plantilla se comprueba al CREAR y no al
  // mandar: descubrirlo destinatario por destinatario significa una campaña
  // que falla entera después de apretar el botón.
  if (deps.variablesDePlantilla) {
    const pide = await deps.variablesDePlantilla(input.templateId);
    const hay = (input.valores ?? []).length;
    if (pide !== hay) {
      throw new Error(
        `Esa plantilla necesita ${pide} valor${pide === 1 ? '' : 'es'} y la campaña trae ${hay}. ` +
          'Para el nombre de cada persona usa {contacto.nombre}.',
      );
    }
  }
  const r = await client.query(
    `INSERT INTO campaigns (tenant_id, name, template_id, filters, values, created_by)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6) RETURNING *`,
    [
      input.tenantId,
      name,
      input.templateId,
      JSON.stringify(input.filtros ?? {}),
      JSON.stringify(input.valores ?? []),
      input.actor ?? null,
    ],
  );
  await writeAudit(client, {
    tenantId: input.tenantId, actor: input.actor ?? 'system',
    actorKind: input.actorKind ?? (input.actor ? 'user' : 'system'),
    action: 'campaign.created', resource: 'campaign', resourceId: r.rows[0].id,
    result: 'ok', requestId: input.requestId,
    metadata: { templateId: input.templateId },
  });
  return aCampana(r.rows[0]);
}

/** A quién le llegaría y a cuántos, con la misma consulta del envío. */
export async function previsualizarCampana(
  client: PoolClient,
  input: { tenantId: string; campaignId: string },
): Promise<{ total: number; muestra: Array<{ id: string; name: string | null; phone: string | null }> }> {
  const c = await obtenerCampana(client, input.tenantId, input.campaignId);
  return previsualizarSegmento(client, { tenantId: input.tenantId, filtros: c.filters });
}

/**
 * Una campaña en el listado: lo suficiente para no tener que abrirla.
 *
 * Lleva el conteo por resultado incluido a propósito. Un listado que solo
 * diga "enviada" obliga a entrar una por una para saber si salió bien, y
 * entonces el listado no sirve de nada.
 */
export interface CampanaEnLista extends Campana {
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /**
   * `encolados` es **encolados**, no entregados, y la diferencia era el bug de
   * #609: un mensaje que WhatsApp rechazó sigue con su fila en `queued`
   * —encolarlo salió bien— así que la lista mostraba «2 encolados · 0 fallidos»
   * con los dos mensajes rechazados por el proveedor. De ahí salía «la campaña
   * dice enviada y 650 personas no recibieron nada»: nadie mentía, el número
   * contaba otra cosa.
   *
   * `noEntregados` cierra ese hueco: son los que el canal rechazó.
   */
  destinatarios: {
    encolados: number;
    saltados: number;
    fallados: number;
    noEntregados: number;
  };
}

/** Cuántas trae como máximo si nadie pide otra cosa. */
export const LIMITE_LISTADO = 50;

/**
 * Las campañas del negocio, la más reciente primero.
 *
 * Una sola consulta con un agregado lateral: la versión obvia —listar y
 * después pedir los resultados de cada una— son N+1 consultas contra
 * `campaign_recipients`, que es la tabla más grande de las dos y la que
 * crece con cada envío.
 *
 * `truncado` dice si quedaron campañas fuera del límite. Sin ese dato, una
 * lista cortada se ve exactamente igual que una lista completa, y eso es
 * mentir en silencio.
 */
export async function listarCampanas(
  client: PoolClient,
  tenantId: string,
  opciones: { limite?: number } = {},
): Promise<{ campanas: CampanaEnLista[]; truncado: boolean }> {
  // `Math.max(NaN, 1)` es NaN, y NaN llega a Postgres como el texto 'NaN'
  // y revienta la consulta. Un límite que viene de un `?limite=` del
  // cliente es exactamente así de confiable, y sanearlo es trabajo de acá:
  // el módulo no puede depender de que quien lo llame lo haya hecho.
  const pedido = Number(opciones.limite);
  const limite = Number.isFinite(pedido)
    ? Math.min(Math.max(Math.trunc(pedido), 1), 100)
    : LIMITE_LISTADO;
  const r = await client.query(
    `SELECT c.*,
            COALESCE(d.encolados, 0)::int AS encolados,
            COALESCE(d.saltados, 0)::int  AS saltados,
            COALESCE(d.fallados, 0)::int  AS fallados,
            COALESCE(d.no_entregados, 0)::int AS no_entregados
       FROM campaigns c
       LEFT JOIN LATERAL (
         SELECT count(*) FILTER (WHERE r.status = 'queued')  AS encolados,
                count(*) FILTER (WHERE r.status = 'skipped') AS saltados,
                count(*) FILTER (WHERE r.status = 'failed')  AS fallados,
                -- Lo que el CANAL rechazó, que no es lo mismo que lo que falló
                -- al encolar (#609). El LEFT JOIN de abajo conserva las filas sin
                -- mensaje —las saltadas— en vez de descartarlas del conteo.
                count(*) FILTER (WHERE m.delivery_status = 'failed') AS no_entregados
           FROM campaign_recipients r
           LEFT JOIN messages m ON m.tenant_id = r.tenant_id AND m.id = r.message_id
          WHERE r.tenant_id = c.tenant_id AND r.campaign_id = c.id
       ) d ON true
      WHERE c.tenant_id = $1
      ORDER BY c.created_at DESC
      LIMIT $2`,
    [tenantId, limite + 1],
  );
  const filas = r.rows.slice(0, limite);
  // Los autores de la lista entera en un viaje, no uno por fila (#697).
  const quien = await quienesSon(client, tenantId, filas.map((f) => f.created_by as string | null));
  return {
    campanas: filas.map((row) => ({
      ...aCampana(row, quien),
      createdAt: (row.created_at as Date).toISOString(),
      startedAt: row.started_at ? (row.started_at as Date).toISOString() : null,
      finishedAt: row.finished_at ? (row.finished_at as Date).toISOString() : null,
      destinatarios: {
        encolados: row.encolados as number,
        noEntregados: row.no_entregados as number,
        saltados: row.saltados as number,
        fallados: row.fallados as number,
      },
    })),
    truncado: r.rows.length > limite,
  };
}

export async function obtenerCampana(
  client: PoolClient,
  tenantId: string,
  campaignId: string,
): Promise<Campana> {
  const r = await client.query('SELECT * FROM campaigns WHERE tenant_id = $1 AND id = $2', [
    tenantId,
    campaignId,
  ]);
  if (r.rowCount === 0) throw new Error('Esa campaña no existe en este negocio.');
  return aCampana(
    r.rows[0],
    await quienesSon(client, tenantId, [
      r.rows[0].created_by as string | null,
      r.rows[0].stopped_by as string | null,
    ]),
  );
}

export interface ResultadoEnvio {
  encolados: number;
  saltados: number;
  motivos: Record<string, number>;
}

/** Cuántos van por lote. Chico a propósito: ver «Por qué lotes chicos». */
export const LOTE_POR_DEFECTO = 100;



/**
 * Lo que una vuelta del job necesita saber del estado de la campaña.
 *
 * **Ojo con la asimetría, porque es una trampa para quien lea esto después:**
 * `encolados`, `saltados` y `motivos` son de ESTE lote; `estado` y `quedan` son
 * de la campaña entera. Sumar los tres primeros entre lotes es correcto; sumar
 * `quedan` no tiene sentido.
 *
 * Y como la campaña cierra con un lote VACÍO —así es como se sabe que no queda
 * nadie a quien escribirle—, quedarse con los contadores del último lote da
 * cero. Quien quiera el total de la campaña lo pide a `resultadosDeCampana`,
 * que lo cuenta de las filas, o acumula.
 */
export interface EstadoDelLote extends ResultadoEnvio {
  /** `sending` si falta gente y nadie pidió parar; si no, el estado final. */
  estado: Campana['status'];
  /** Cuántos quedaron sin tocar. Cero no significa que salieron todos. */
  quedan: number;
  /** Por qué se cortó, si se cortó. Se le muestra al dueño tal cual. */
  motivoDelCorte: string | null;
  /**
   * Había OTRO lote de esta campaña corriendo y este no hizo nada.
   *
   * Quien llama no debe volver a encolar en este caso: el lote que tiene el
   * candado va a encolar el siguiente cuando termine. Si los dos encolaran, dos
   * jobs se turnarían el candado para siempre sin que ninguno avance.
   */
  yaHabiaOtroLote: boolean;
}

interface DepsDeEnvio {
  calidadDelNumero: () => Promise<'verde' | 'amarillo' | 'rojo'>;
  puedeIniciar: (contactId: string) => Promise<boolean>;
  conversacionDe: (contactId: string) => Promise<string | null>;
  /** Lo que se necesita para personalizar: nombre y teléfono. */
  datosDelContacto?: (contactId: string) => Promise<{ name?: string | null; phone?: string | null }>;
  enviarPlantilla: (args: {
    conversationId: string;
    contactId: string;
    templateId: string;
    valores: string[];
  }) => Promise<{ messageId: string }>;
  /**
   * ¿El canal rechazó por tope algo de esta campaña? Devuelve el motivo o null.
   *
   * Opcional: sin esto la campaña sigue funcionando y simplemente no corta por
   * tope —lo que pasaba antes de #609—, así que los tests que no lo necesitan no
   * tienen que fingirlo.
   */
  canalLleno?: () => Promise<string | null>;
}

/**
 * Lanza la campaña: la deja lista para que el job la mande, y vuelve (#609).
 *
 * Lo que esto NO hace es mandar. Antes, `POST /campanas/:id/enviar` recorría el
 * segmento completo dentro del request y dentro de una sola transacción, y de
 * ahí salían tres cosas a la vez:
 *
 *  · 900 contactos en un request HTTP es un timeout esperando ocurrir.
 *  · Cuando el tope diario del canal cortaba a mitad de camino, el resto quedaba
 *    `failed` y **la campaña se reportaba como enviada**: el dueño veía «enviada,
 *    900» y 650 personas nunca recibieron nada.
 *  · No existía ningún punto donde consultar si alguien pidió parar, así que
 *    `cancelled` estaba en el esquema y nada lo escribía (#610).
 *
 * Acá se valida, se congela el total y se deja en `sending`. Quien llama encola.
 */
export async function iniciarCampana(
  client: PoolClient,
  input: { tenantId: string; campaignId: string; actor?: string; actorKind?: ActorKind; requestId?: string },
  deps: Pick<DepsDeEnvio, 'calidadDelNumero'>,
): Promise<{ campana: Campana; total: number; truncado: boolean }> {
  const campana = await obtenerCampana(client, input.tenantId, input.campaignId);
  if (campana.status !== 'draft') {
    throw new Error(
      campana.status === 'sending'
        ? 'Esta campaña ya está saliendo.'
        : campana.status === 'partial'
          ? 'Esta campaña quedó a medias. Usa «seguir» para mandar los que faltan.'
          : 'Esta campaña ya está cerrada.',
    );
  }

  // La calidad del número manda: en rojo no sale nada. En amarillo sale,
  // pero queda dicho en el evento para que se vea en la pantalla.
  const calidad = await deps.calidadDelNumero();
  if (calidad === 'rojo') {
    throw new Error(
      'El número está en calidad ROJA: una campaña ahora es la forma más corta de perderlo. ' +
        'Primero hay que recuperar la calidad.',
    );
  }

  // El total se congela acá, como los filtros. Sin esto «250 de 900» se mueve
  // solo: basta que entre un contacto al segmento mientras la campaña sale.
  const { total, truncado } = await contarSegmento(client, {
    tenantId: input.tenantId,
    filtros: campana.filters,
  });

  await client.query(
    `UPDATE campaigns
        SET status = 'sending', started_at = now(), planned_total = $3,
            stop_requested_at = NULL, stopped_by = NULL, stop_reason = NULL
      WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.campaignId, total],
  );

  await writeAudit(client, {
    tenantId: input.tenantId, actor: input.actor ?? 'system',
    actorKind: input.actorKind ?? (input.actor ? 'user' : 'system'),
    action: 'campaign.started', resource: 'campaign', resourceId: input.campaignId,
    result: 'ok', requestId: input.requestId,
    metadata: { total, truncado, calidad },
  });

  return {
    campana: await obtenerCampana(client, input.tenantId, input.campaignId),
    total,
    truncado,
  };
}

/**
 * Detener una campaña que está saliendo (#610).
 *
 * Deja la SOLICITUD escrita; el estado lo cambia el job cuando termina el lote
 * que tiene entre manos. Separar las dos cosas no es un detalle de
 * implementación: **lo que ya se mandó al proveedor no se puede desencolar**, y
 * un estado que dijera `cancelled` al instante estaría prometiendo que los
 * últimos no salieron. El aviso al dueño dice la verdad porque el estado la dice.
 *
 * Quien puede detenerla es quien puede lanzarla, mismo permiso: el daño corre
 * mientras se busca a quien tenga uno especial.
 */
export async function detenerCampana(
  client: PoolClient,
  input: {
    tenantId: string;
    campaignId: string;
    actor?: string;
    actorKind?: ActorKind;
    requestId?: string;
    motivo?: string;
  },
): Promise<{ campana: Campana; encolados: number; sinTocar: number }> {
  const campana = await obtenerCampana(client, input.tenantId, input.campaignId);
  if (campana.status !== 'sending' && campana.status !== 'partial') {
    throw new Error(
      campana.status === 'draft'
        ? 'Esta campaña todavía no sale: no hay nada que detener.'
        : 'Esta campaña ya está cerrada.',
    );
  }

  await client.query(
    `UPDATE campaigns
        SET stop_requested_at = now(), stopped_by = $3, stop_reason = $4
      WHERE tenant_id = $1 AND id = $2 AND stop_requested_at IS NULL`,
    [input.tenantId, input.campaignId, input.actor ?? null, input.motivo ?? 'detenida a mano'],
  );

  /**
   * ¿Hay un lote corriendo ahora mismo? El candado lo sabe.
   *
   * Si NO lo hay —porque el job todavía no partió, porque el worker está caído,
   * o porque la campaña ya estaba `partial`— se cierra acá mismo. Esto no es una
   * optimización: sin esto, detener dejaba el estado en `sending` hasta que
   * corriera un lote, así que la persona apretaba «Detener», leía «salieron 180
   * y 2.800 no se van a enviar»… y la pantalla seguía diciendo «Saliendo». Y si
   * el worker estaba caído, para siempre.
   *
   * Si SÍ hay un lote corriendo, no se toca el estado: ese lote lee la solicitud
   * y cierra al terminar. Pisarle el estado desde acá sería decidir sobre
   * mensajes que todavía están saliendo.
   */
  const sinLoteCorriendo = await client.query(
    'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS tomado',
    [`campana:${input.campaignId}`],
  );
  if (sinLoteCorriendo.rows[0].tomado === true) {
    await client.query(
      `UPDATE campaigns SET status = 'cancelled', finished_at = now()
        WHERE tenant_id = $1 AND id = $2 AND status IN ('sending', 'partial')`,
      [input.tenantId, input.campaignId],
    );
  }

  const r = await client.query(
    `SELECT count(*) FILTER (WHERE status = 'queued')::int AS encolados,
            count(*)::int AS con_fila
       FROM campaign_recipients WHERE tenant_id = $1 AND campaign_id = $2`,
    [input.tenantId, input.campaignId],
  );
  const encolados = r.rows[0].encolados as number;
  const sinTocar = Math.max(0, (campana.plannedTotal ?? 0) - (r.rows[0].con_fila as number));

  await writeAudit(client, {
    tenantId: input.tenantId, actor: input.actor ?? 'system',
    actorKind: input.actorKind ?? (input.actor ? 'user' : 'system'),
    action: 'campaign.stopped', resource: 'campaign', resourceId: input.campaignId,
    result: 'ok', requestId: input.requestId,
    metadata: { encolados, sinTocar, motivo: input.motivo ?? 'detenida a mano' },
  });

  return {
    campana: await obtenerCampana(client, input.tenantId, input.campaignId),
    encolados,
    sinTocar,
  };
}

/**
 * Devolver a borrador una campaña que se lanzó y no se pudo encolar.
 *
 * Existe para un caso chico y con mala pinta: `iniciarCampana` commitea
 * `sending` y después hay que encolar el job, que es otro sistema y se puede
 * caer. Sin esto la campaña queda `sending` para siempre —el dueño mirando un
 * progreso que nadie va a mover— y sin salida, porque `iniciarCampana` rechaza
 * todo lo que no sea `draft`.
 *
 * Solo revierte si NADIE recibió nada: si un lote alcanzó a salir, la campaña ya
 * pasó algo y volver a `draft` borraría ese hecho de la pantalla.
 */
export async function volverABorrador(
  client: PoolClient,
  input: { tenantId: string; campaignId: string },
): Promise<boolean> {
  const r = await client.query(
    `UPDATE campaigns c
        SET status = 'draft', started_at = NULL, planned_total = NULL
      WHERE c.tenant_id = $1 AND c.id = $2 AND c.status = 'sending'
        AND NOT EXISTS (
          SELECT 1 FROM campaign_recipients r
           WHERE r.tenant_id = c.tenant_id AND r.campaign_id = c.id
        )`,
    [input.tenantId, input.campaignId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Seguir una campaña que quedó a medias: vuelve a `sending` para que el job la retome. */
export async function seguirCampana(
  client: PoolClient,
  input: { tenantId: string; campaignId: string; actor?: string; actorKind?: ActorKind; requestId?: string },
  deps: Pick<DepsDeEnvio, 'calidadDelNumero'>,
): Promise<Campana> {
  const campana = await obtenerCampana(client, input.tenantId, input.campaignId);
  if (campana.status !== 'partial') {
    throw new Error('Solo se puede seguir una campaña que quedó a medias.');
  }
  if ((await deps.calidadDelNumero()) === 'rojo') {
    throw new Error(
      'El número está en calidad ROJA: seguir esta campaña ahora es la forma más corta de perderlo.',
    );
  }
  await client.query(
    `UPDATE campaigns
        SET status = 'sending', stop_requested_at = NULL, stopped_by = NULL,
            stop_reason = NULL, finished_at = NULL
      WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.campaignId],
  );
  await writeAudit(client, {
    tenantId: input.tenantId, actor: input.actor ?? 'system',
    actorKind: input.actorKind ?? (input.actor ? 'user' : 'system'),
    action: 'campaign.resumed', resource: 'campaign', resourceId: input.campaignId,
    result: 'ok', requestId: input.requestId, metadata: {},
  });
  return obtenerCampana(client, input.tenantId, input.campaignId);
}

/**
 * Manda UN lote y dice cómo seguir. Cada destinatario pasa por su propia
 * decisión y queda registrado, salga o no.
 *
 * `deps` trae lo que no le corresponde saber a este módulo: si la plantilla
 * está aprobada, si la persona consintió, cómo se escribe un mensaje y cómo
 * se encola. Así esto se prueba entero sin red ni proveedor.
 *
 * ## Por qué lotes chicos
 *
 * El lote es la granularidad con la que se puede parar, y parar es el punto
 * de #610: el vendedor que ve «Hola ,» en la bandeja tiene que poder detener
 * la campaña antes de que salgan los 2.800 que faltan. Un lote de 1.000 haría
 * que el botón tardara mil mensajes en tener efecto.
 *
 * ## Las dos formas de cortar, y las dos dejan dicho por qué
 *
 *  · **Alguien pidió parar** (`stop_requested_at`): se consulta ANTES de cada
 *    destinatario, no una vez por lote. Lo ya mandado al proveedor puede
 *    alcanzar a entregarse y el estado no promete lo contrario.
 *  · **El tope diario del canal**: el proveedor contesta
 *    `DAILY_LIMIT_EXCEEDED` y se corta ahí mismo. No se sigue intentando con
 *    los que faltan, porque se van a caer todos igual y cada intento es un
 *    `failed` que no significa nada sobre esa persona.
 */
export async function enviarLoteDeCampana(
  client: PoolClient,
  input: {
    tenantId: string;
    campaignId: string;
    lote?: number;
    actor?: string;
    actorKind?: ActorKind;
    requestId?: string;
  },
  deps: DepsDeEnvio,
): Promise<EstadoDelLote> {
  const campana = await obtenerCampana(client, input.tenantId, input.campaignId);
  if (campana.status !== 'sending') {
    /**
     * Un lote que llega tarde no es un error: la cola es at-least-once.
     *
     * Pasa de verdad y por un camino corto: alguien detiene la campaña, el
     * candado estaba libre y `detenerCampana` la cierra en el acto; el job que
     * ya estaba encolado llega después. Lanzar acá convertiría eso en cinco
     * reintentos con backoff y un `failed` en la cola, por algo que salió
     * exactamente como debía.
     */
    return {
      encolados: 0,
      saltados: 0,
      motivos: {},
      estado: campana.status,
      quedan: 0,
      motivoDelCorte: campana.stopReason,
      yaHabiaOtroLote: false,
    };
  }

  /**
   * Un lote a la vez por campaña, y por qué un candado de AVISO y no `FOR UPDATE`.
   *
   * Dos lotes de la misma campaña corriendo juntos se pisan de la peor manera:
   * los dos piden «los que todavía no tienen fila», los dos reciben a la MISMA
   * gente —el anti-join no ve filas que la otra transacción no commiteó— y los
   * dos mandan. El `ON CONFLICT` de `anotar` evita la fila repetida, no el
   * mensaje repetido: el cliente lo recibe dos veces y se paga dos veces.
   *
   * `SELECT … FROM campaigns … FOR UPDATE` lo arreglaría y rompería otra cosa:
   * `detenerCampana` hace un UPDATE sobre esa misma fila, así que el botón de
   * «Detener» quedaría esperando a que termine el lote —hasta cien envíos— y
   * detener a tiempo es todo el punto de #610. Un candado de aviso no toca la
   * fila.
   *
   * El `hashtext` de un uuid vive en 32 bits: dos campañas distintas pueden
   * colisionar. Lo que pasa entonces es que se turnan en vez de ir en paralelo,
   * nunca que se mezclen — el candado no decide a quién se le manda, solo quién
   * pasa primero.
   */
  const candado = await client.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS tomado', [
    `campana:${input.campaignId}`,
  ]);
  if (candado.rows[0].tomado !== true) {
    const conFilaYa = await client.query(
      `SELECT count(*)::int AS n FROM campaign_recipients WHERE tenant_id = $1 AND campaign_id = $2`,
      [input.tenantId, input.campaignId],
    );
    return {
      encolados: 0,
      saltados: 0,
      motivos: {},
      estado: 'sending',
      quedan: Math.max(0, (campana.plannedTotal ?? 0) - (conFilaYa.rows[0].n as number)),
      motivoDelCorte: null,
      yaHabiaOtroLote: true,
    };
  }

  /**
   * La calidad del número, **en cada lote** y no solo al lanzar (#609).
   *
   * Antes el envío era una sola llamada, así que preguntar una vez al principio
   * y preguntar «durante» eran lo mismo. Por lotes dejaron de serlo: una campaña
   * de 3.000 contactos tarda minutos u horas, y lo que pone un número en rojo es
   * justamente que mucha gente reciba algo que no pidió y lo reporte. O sea que
   * el caso que la guarda existe para evitar —«una campaña ahora es la forma más
   * corta de perder el número»— es el que la campaña misma puede provocar
   * mientras sale.
   *
   * Sin esto, batchear habría convertido una guarda que se evaluaba antes del
   * daño en una que se evalúa antes del PRIMER lote y nunca más. Es una
   * consulta por lote, y es exactamente para lo que está.
   */
  if ((await deps.calidadDelNumero()) === 'rojo') {
    const quedanAhora = await client.query(
      `SELECT count(*)::int AS n FROM campaign_recipients WHERE tenant_id = $1 AND campaign_id = $2`,
      [input.tenantId, input.campaignId],
    );
    const sinRecibir = Math.max(0, (campana.plannedTotal ?? 0) - (quedanAhora.rows[0].n as number));
    const motivo =
      'el número pasó a calidad ROJA mientras la campaña salía, así que se detuvo: ' +
      'seguir ahora es la forma más corta de perderlo.';
    await client.query(
      `UPDATE campaigns SET status = 'partial', finished_at = now(),
              stop_reason = COALESCE(stop_reason, $3)
        WHERE tenant_id = $1 AND id = $2`,
      [input.tenantId, input.campaignId, motivo],
    );
    await writeAudit(client, {
      tenantId: input.tenantId, actor: input.actor ?? 'system',
      actorKind: input.actorKind ?? (input.actor ? 'user' : 'system'),
      action: 'campaign.sent', resource: 'campaign', resourceId: input.campaignId,
      result: 'ok', requestId: input.requestId,
      metadata: { estado: 'partial', quedan: sinRecibir, motivoDelCorte: motivo },
    });
    return {
      encolados: 0,
      saltados: 0,
      motivos: {},
      estado: 'partial',
      quedan: sinRecibir,
      motivoDelCorte: motivo,
      yaHabiaOtroLote: false,
    };
  }

  const motivos: Record<string, number> = {};
  let encolados = 0;
  let saltados = 0;
  let motivoDelCorte: string | null = null;

  const anotar = async (
    contactId: string,
    status: 'queued' | 'skipped' | 'failed',
    reason: string | null,
    messageId?: string,
  ) => {
    // ON CONFLICT: si el disparo se repite, la misma persona no recibe la
    // misma campaña dos veces. Y es lo que hace que retomar un lote caído a
    // la mitad sea idempotente sin guardar por dónde iba.
    const r = await client.query(
      `INSERT INTO campaign_recipients (tenant_id, campaign_id, contact_id, message_id, status, reason)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (campaign_id, contact_id) DO NOTHING
       RETURNING id`,
      [input.tenantId, input.campaignId, contactId, messageId ?? null, status, reason],
    );
    return (r.rowCount ?? 0) > 0;
  };

  /** ¿Alguien pidió parar mientras este lote salía? Se relee, no se cachea. */
  const pidieronParar = async (): Promise<boolean> => {
    const r = await client.query(
      'SELECT stop_requested_at FROM campaigns WHERE tenant_id = $1 AND id = $2',
      [input.tenantId, input.campaignId],
    );
    return r.rows[0]?.stop_requested_at != null;
  };

  /**
   * ¿El canal ya se llenó? Se PREGUNTA, no se deduce.
   *
   * Antes de fabricar cien mensajes más conviene saber si los anteriores están
   * siendo rechazados por tope: seguir encolando contra un canal lleno solo
   * agrega mensajes que van a fallar.
   *
   * Va por `deps` y no con una consulta acá, y eso no es ceremonia: la respuesta
   * vive en cómo el adaptador del canal guarda sus rechazos, y este módulo no
   * tiene por qué saber eso. Mi primera versión preguntaba con un
   * `meta->>'error' ILIKE '%tope diario%'` desde acá — una consulta de
   * automations contra la prosa de whatsapp, que se rompe en silencio el día que
   * alguien mejore la redacción.
   *
   * Y la primera versión de la primera versión era peor: lo buscaba en el
   * `catch` del envío, donde no podía aparecer nunca, porque `enviarPlantilla`
   * no habla con el proveedor —crea el mensaje y lo deja en la cola—. Una guarda
   * que se leía bien y no se disparaba jamás.
   */
  if (deps.canalLleno) {
    motivoDelCorte = await deps.canalLleno();
  }

  const contactos = motivoDelCorte
    ? []
    : await loteSiguienteDeCampana(client, {
        tenantId: input.tenantId,
        filtros: campana.filters,
        campaignId: input.campaignId,
        lote: input.lote ?? LOTE_POR_DEFECTO,
      });

  for (const contactId of contactos) {
    if (await pidieronParar()) {
      motivoDelCorte = campana.stopReason ?? 'detenida a mano';
      break;
    }
    if (!(await deps.puedeIniciar(contactId))) {
      if (await anotar(contactId, 'skipped', 'sin consentimiento')) {
        saltados += 1;
        motivos['sin consentimiento'] = (motivos['sin consentimiento'] ?? 0) + 1;
      }
      continue;
    }
    const conversationId = await deps.conversacionDe(contactId);
    if (!conversationId) {
      if (await anotar(contactId, 'skipped', 'sin conversación abierta por ese canal')) {
        saltados += 1;
        motivos['sin conversación'] = (motivos['sin conversación'] ?? 0) + 1;
      }
      continue;
    }
    try {
      // Personalizado por destinatario: `{contacto.nombre}` es el nombre de
      // quien lee, no el de la primera persona de la lista.
      const datos = deps.datosDelContacto ? await deps.datosDelContacto(contactId) : {};
      const { messageId } = await deps.enviarPlantilla({
        conversationId,
        contactId,
        templateId: campana.templateId,
        valores: resolverValores(campana.values, datos),
      });
      if (await anotar(contactId, 'queued', null, messageId)) encolados += 1;
    } catch (err) {
      const motivo = (err as Error).message.slice(0, 200);
      if (await anotar(contactId, 'failed', motivo)) {
        saltados += 1;
        motivos[motivo] = (motivos[motivo] ?? 0) + 1;
      }
    }
  }

  // Cuántos quedaron SIN TOCAR: contra el total congelado, no contra el
  // segmento de ahora. Un «quedan 0» calculado sobre el segmento actual mentiría
  // cada vez que alguien saliera del segmento mientras la campaña sale.
  const conFila = await client.query(
    `SELECT count(*)::int AS n FROM campaign_recipients WHERE tenant_id = $1 AND campaign_id = $2`,
    [input.tenantId, input.campaignId],
  );
  const quedan = Math.max(0, (campana.plannedTotal ?? 0) - (conFila.rows[0].n as number));

  /**
   * El estado, y el orden de las preguntas es la mitad del asunto.
   *
   * **`quedan === 0` va primero.** Sin eso, una solicitud de parar que llegaba
   * mientras salía el último lote dejaba la campaña en `cancelled` aunque todos
   * hubieran recibido el mensaje. «Detenida» cuando salió completa es tan falso
   * como «enviada» cuando quedó gente afuera, solo que miente para el otro
   * lado: el dueño cree que ahorró mensajes que ya se pagaron.
   *
   * **Y el lote vacío CIERRA la campaña.** Esto es lo que evita un bucle
   * caliente, y el camino para llegar ahí no es raro: alguien se da de baja
   * mientras la campaña sale. El segmento exige `opted_out_at IS NULL`, así que
   * esa persona desaparece del lote siguiente —correcto, no hay que
   * escribirle— pero nunca llega a tener fila en `campaign_recipients`. Y
   * `quedan` se cuenta contra el total CONGELADO, así que se queda en 1 para
   * siempre:
   *
   *   lote vacío → quedan = 1 > 0 → `sending` → se encola otra vez → lote
   *   vacío → … y el worker gira sin fin pidiendo a la base un segmento que ya
   *   no tiene a nadie.
   *
   * Contar `quedan` contra el segmento de AHORA lo arreglaría y rompería el
   * informe: el denominador se movería cada vez que alguien entra o sale, que es
   * justo lo que congelar el total vino a evitar. Así que el total se queda
   * congelado, `quedan` sigue diciendo la verdad —esa persona no recibió— y lo
   * que cierra la campaña es que no haya nadie más a quien escribirle.
   *
   * **Y por eso cierra el lote vacío y no `quedan === 0`.** Con el atajo
   * `quedan === 0 → done` la campaña podía cerrarse con gente del segmento
   * original todavía sin recibir: basta que entren contactos nuevos al segmento
   * mientras sale —anotan fila, `quedan` llega a cero— y alguno de los
   * originales quede atrás porque su `created_at` lo pone después. Cuesta un
   * lote vacío de más por campaña (una consulta) y a cambio la única condición
   * de término es la que de verdad significa «no hay a quién escribirle».
   */
  const detenida = await pidieronParar();
  let estado: Campana['status'];
  if (detenida) {
    // Si no quedó nadie afuera, salió completa aunque la parada llegara.
    estado = quedan === 0 ? 'done' : 'cancelled';
  } else if (motivoDelCorte) {
    estado = 'partial';
  } else if (contactos.length === 0) {
    if (quedan === 0) estado = 'done';
    else {
      motivoDelCorte =
        `${quedan} ${quedan === 1 ? 'persona' : 'personas'} ya no estaban en el segmento cuando ` +
        'les tocaba: se dieron de baja o dejaron de cumplir el filtro mientras la campaña salía.';
      estado = 'partial';
    }
  } else {
    estado = 'sending';
  }

  if (estado !== 'sending') {
    await client.query(
      `UPDATE campaigns SET status = $3, finished_at = now(),
              stop_reason = COALESCE(stop_reason, $4)
        WHERE tenant_id = $1 AND id = $2`,
      [input.tenantId, input.campaignId, estado, motivoDelCorte],
    );
    const totales = await client.query(
      `SELECT count(*) FILTER (WHERE status = 'queued')::int AS encolados,
              count(*) FILTER (WHERE status <> 'queued')::int AS saltados
         FROM campaign_recipients WHERE tenant_id = $1 AND campaign_id = $2`,
      [input.tenantId, input.campaignId],
    );
    // El evento sale UNA vez, al cerrar, con los totales de la campaña entera y
    // no los del último lote. No es una precaución teórica:
    //
    // `campaign.sent` no tiene consumidor DENTRO del sistema, pero sí sale
    // hacia afuera. Los webhooks salientes (#93) ofrecen al tenant cualquier
    // evento del catálogo, y el catálogo es «todo lo que publica un módulo
    // activo» (`registry.eventsCatalog()`). O sea que un negocio con un
    // endpoint suscrito a `campaign.sent` habría recibido **un webhook por
    // lote**, cada uno con los totales parciales, y lo que arme del otro lado
    // habría contado la misma campaña veinte veces.
    await publishEvent(client, {
      name: 'campaign.sent',
      tenantId: input.tenantId,
      payload: {
        campaignId: input.campaignId,
        estado,
        encolados: totales.rows[0].encolados as number,
        saltados: totales.rows[0].saltados as number,
        quedan,
        motivoDelCorte,
      },
      actor: input.actor ?? 'system',
      requestId: input.requestId,
    });
    await writeAudit(client, {
      tenantId: input.tenantId, actor: input.actor ?? 'system',
      actorKind: input.actorKind ?? (input.actor ? 'user' : 'system'),
      action: 'campaign.sent', resource: 'campaign', resourceId: input.campaignId,
      result: 'ok', requestId: input.requestId,
      metadata: {
        estado,
        encolados: totales.rows[0].encolados as number,
        saltados: totales.rows[0].saltados as number,
        quedan,
        motivoDelCorte,
      },
    });
  }

  return { encolados, saltados, motivos, estado, quedan, motivoDelCorte, yaHabiaOtroLote: false };
}

/**
 * Cómo le fue: lo que se encoló, lo que se saltó con su motivo, y qué pasó
 * después con cada mensaje (entregado, leído, fallido) según lo que contó
 * el proveedor.
 */
export async function resultadosDeCampana(
  client: PoolClient,
  input: { tenantId: string; campaignId: string },
): Promise<{
  porEstado: Record<string, number>;
  motivos: Array<{ motivo: string; n: number }>;
  entrega: Record<string, number>;
  costoUsd: number;
}> {
  const estados = await client.query(
    `SELECT status, count(*)::int AS n FROM campaign_recipients
      WHERE tenant_id = $1 AND campaign_id = $2 GROUP BY status`,
    [input.tenantId, input.campaignId],
  );
  const motivos = await client.query(
    `SELECT reason, count(*)::int AS n FROM campaign_recipients
      WHERE tenant_id = $1 AND campaign_id = $2 AND reason IS NOT NULL
      GROUP BY reason ORDER BY n DESC`,
    [input.tenantId, input.campaignId],
  );
  const entrega = await client.query(
    `SELECT m.delivery_status, count(*)::int AS n
       FROM campaign_recipients r JOIN messages m ON m.id = r.message_id
      WHERE r.tenant_id = $1 AND r.campaign_id = $2
      GROUP BY m.delivery_status`,
    [input.tenantId, input.campaignId],
  );
  const costo = await client.query(
    `SELECT COALESCE(SUM((m.meta->'costo'->>'amount')::numeric), 0) AS total
       FROM campaign_recipients r JOIN messages m ON m.id = r.message_id
      WHERE r.tenant_id = $1 AND r.campaign_id = $2`,
    [input.tenantId, input.campaignId],
  );

  return {
    porEstado: Object.fromEntries(estados.rows.map((x) => [x.status, x.n])),
    motivos: motivos.rows.map((x) => ({ motivo: x.reason as string, n: x.n as number })),
    entrega: Object.fromEntries(entrega.rows.map((x) => [x.delivery_status ?? 'sin estado', x.n])),
    costoUsd: Number(costo.rows[0].total),
  };
}

/**
 * Las campañas que dicen «saliendo» y no avanzan (#609).
 *
 * Qué las deja así: el job se encola en Redis después del `COMMIT`, y entre los
 * dos hay un sistema que se puede caer. `iniciarCampana` revierte a borrador si
 * encolar falla en el mismo request, pero eso no cubre el job que se pierde, el
 * worker que estuvo caído mientras alguien lanzaba, ni el módulo que se apagó y
 * se volvió a prender. El resultado es siempre el mismo y es el peor para quien
 * mira: una campaña «saliendo» que nadie está mandando.
 *
 * Mismo modo de falla que las plantillas colgadas de #44, misma respuesta: el
 * barrido pregunta en vez de esperar. Volver a encolar es seguro porque el
 * candado de lote impide que dos salgan juntas y porque el cursor es la tabla de
 * destinatarios: lo que ya salió no vuelve a salir.
 */
export async function campanasSinAvance(
  client: PoolClient,
  tenantId: string,
  minutos = 10,
): Promise<string[]> {
  const r = await client.query(
    `SELECT c.id FROM campaigns c
      WHERE c.tenant_id = $1 AND c.status = 'sending'
        AND GREATEST(
              c.started_at,
              COALESCE(
                (SELECT max(r.created_at) FROM campaign_recipients r
                  WHERE r.tenant_id = c.tenant_id AND r.campaign_id = c.id),
                c.started_at
              )
            ) < now() - make_interval(mins => $2)
      ORDER BY c.started_at`,
    [tenantId, Math.max(1, Math.floor(minutos))],
  );
  return r.rows.map((x) => x.id as string);
}
