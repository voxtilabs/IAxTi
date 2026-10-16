import type { PoolClient } from 'pg';
import { degradarSinRomper } from '@iaxti/db';

/**
 * La exportación completa del tenant (issue 222, SPEC §6 y §19).
 *
 * Tres cosas la necesitan y ninguna la tenía: la cancelación en un clic («con
 * exportación completa antes»), el borrado a los 90 días («se ofrece
 * exportación y se elimina») y la portabilidad de la Ley 21.719.
 *
 * Dos reglas gobiernan lo que sale:
 *
 *  1. **Es del negocio, no nuestro.** Va lo que el cliente escribió o generó:
 *     sus contactos, sus conversaciones, sus oportunidades, su configuración.
 *     No va nuestra mecánica interna —la cola de eventos, las llaves de
 *     idempotencia, las sesiones de soporte—: no le sirve y no es suya.
 *
 *  2. **Jamás un secreto.** Ni hashes de API keys, ni tokens de invitación,
 *     ni secretos de webhook. Las REFERENCIAS a credenciales sí van: son
 *     nombres de variables de entorno, no valores, y sin ellas la
 *     configuración exportada no se entiende.
 *
 * Lo que queda fuera está escrito acá con su motivo. Una exportación que no
 * dice qué dejó afuera obliga a confiar; esta se puede revisar.
 */

/** Columnas que NUNCA salen. */
const COLUMNAS_PROHIBIDAS: Record<string, string[]> = {
  api_keys: ['key_hash'],
  invitations: ['token'],
  webhook_endpoints: ['secret'],
};

/** Tabla → por qué NO se exporta. */
export const FUERA_DE_LA_EXPORTACION: Record<string, string> = {
  google_oauth_attempts: 'Intentos de consentimiento OAuth de cada persona: hashes y datos de autenticación efímeros.',
  google_oauth_grants: 'Custodia del consentimiento personal de Google: referencias a secretos, no configuración del negocio.',
  google_secret_versions: 'Cola interna de destrucción de credenciales de Google.',
  calendar_google_watches: 'Credenciales y leases del transporte push de Google; no son datos del negocio.',
  calendar_freebusy_cache: 'Caché temporal de ocupación de calendarios personales; se reconstruye desde Google.',

  initial_business_registrations:
    'Referencia interna para no duplicar el alta inicial al reintentar. El negocio y sus miembros se exportan en tenants y user_roles; esta referencia no concede acceso.',
  audit_log:
    'Tiene su propia exportación firmada y encadenada (#72): meterla acá sin la firma la degrada.',
  outbox: 'Cola de eventos: mecánica nuestra, no datos del negocio.',
  processed_events: 'Idem outbox.',
  idempotency_keys: 'Llaves de reintento con vida de 24 h; fuera de ese momento no significan nada.',
  knowledge_query_cache: 'Caché: se reconstruye sola y no es información nueva.',
  pending_file_deletions:
    'Anotación NUESTRA de un borrado de archivo en curso (#751): la llave del objeto en el bucket, para poder reconciliar si el proceso muere a medias. Es mecánica de nuestro almacenamiento, no dato del negocio.',
  platform_support_sessions: 'Registro NUESTRO de cuándo miramos su cuenta; no es dato suyo.',
  agente_general_apagado:
    'Interruptor NUESTRO: dice si le pausamos la configuración por conversación y por qué. Es una decisión de operación de la plataforma, no información del negocio.',
  push_subscriptions: 'Llaves del navegador de cada persona: no sirven fuera de ese navegador.',
  api_keys: 'De la credencial solo guardamos el hash, y un hash no se exporta.',
  eval_cases: 'Nuestras pruebas de calidad del copiloto.',
  eval_runs: 'Idem eval_cases.',
  agent_quota_alerts: 'Marcas internas para no avisar dos veces por ciclo.',
  agent_proposals:
    'Propuestas de configuración que el copiloto sugiere y el ADMIN acepta o descarta: mecánica del configurador, no dato del negocio.',
};

/**
 * Las tablas que SÍ salen, en orden de lectura. El orden importa poco para
 * la máquina y mucho para quien abra el archivo: primero las personas,
 * después las conversaciones, después el negocio, al final la configuración.
 */
export const TABLAS_EXPORTADAS = [
  'contacts',
  'contact_identities',
  'contact_tags',
  'tags',
  'companies',
  'custom_fields',
  'conversations',
  'messages',
  'internal_notes',
  'assignments',
  'quick_replies',
  'response_samples',
  'suggestions',
  'agent_executions',
  // Si el agente logró su objetivo en esa conversación (#319). Es sobre el
  // contacto: se exporta con él, como todo lo que decimos que guardamos.
  'agent_goal_attempts',
  'agents',
  'agent_conversation_modes',
  'deals',
  'deal_stage_history',
  'pipelines',
  'stages',
  'loss_reasons',
  'products',
  'activities',
  'availability',
  'calendar_connections',
  'appointments',
  'saved_filters',
  'rules',
  'rule_runs',
  'segments',
  'campaigns',
  'campaign_recipients',
  'sequences',
  'sequence_enrollments',
  'sources',
  'chunks',
  // Los `[[enlaces]]` entre fuentes (#714). Van con las fuentes porque son
  // parte de lo que esos documentos dicen: quien se lleva su conocimiento en
  // markdown se lleva también cómo estaba relacionado, que es la mitad del
  // valor de haberlo escrito así.
  'source_links',
  'channel_accounts',
  'channel_senders',
  'whatsapp_numbers',
  'whatsapp_templates',
  'webchat_widgets',
  'webchat_sessions',
  'webhook_endpoints',
  'webhook_deliveries',
  'payment_providers',
  'payment_links',
  'payments',
  'invoices',
  'subscriptions',
  'usage_meters',
  'daily_metrics',
  'teams',
  'roles',
  'user_roles',
  'invitations',
  'notification_preferences',
  'notifications',
] as const;

export interface ExportacionTenant {
  tenant: Record<string, unknown>;
  generadoEl: string;
  datos: Record<string, Array<Record<string, unknown>>>;
  resumen: Record<string, number>;
  /**
   * Tablas que llegaron al tope y NO salieron completas. Vacío es la
   * respuesta normal; si trae algo, la exportación está incompleta y hay que
   * decirlo en voz alta en vez de esconderlo en un contador.
   */
  truncadas: string[];
  fuera: Record<string, string>;
  /**
   * Los adjuntos del negocio, con lo que hace falta para poder bajarlos (#583).
   *
   * Antes esto era `string[]`: las llaves PELADAS de R2, con el comentario «los
   * archivos se piden aparte». No había ninguna ruta que los pidiera. O sea que
   * el cliente que cancelaba se llevaba la REFERENCIA a sus fotos, cotizaciones
   * y comprobantes, y no las fotos — y el comentario de `POST /billing/cancelar`
   * prometía «la exportación entera».
   *
   * Para una obligación de «llevarse lo suyo» (SPEC §19, Ley 21.719) eso es
   * entregar la mitad y decir que es todo.
   *
   * Acá va la metadata; la URL firmada la pone quien tiene la configuración del
   * almacén —este módulo no firma nada, igual que no manda mensajes.
   */
  adjuntos: AdjuntoExportado[];
  /**
   * Cuántos adjuntos quedaron fuera por el tope, si quedó alguno.
   *
   * Mismo criterio que `truncadas`: una exportación que calla lo que no incluyó
   * es peor que una que avisa, porque se descubre cuando el negocio ya canceló.
   */
  adjuntosFuera: number;
}

export interface AdjuntoExportado {
  /** La llave en R2. Va igual: es el nombre del archivo dentro del paquete. */
  key: string;
  /** El nombre que el archivo tenía cuando se subió, para que se reconozca. */
  nombre: string;
  conversationId: string | null;
  messageId: string | null;
  bytes: number | null;
  contentType: string | null;
}

/** Tope por tabla, para que un tenant enorme no voltee el proceso. */
export const TOPE_POR_TABLA = 50_000;

/**
 * Tope de adjuntos en una exportación, con su motivo (#583).
 *
 * No es un número cómodo: es el punto donde el paquete deja de ser algo que una
 * persona abre. Con el promedio de los adjuntos de WhatsApp —una foto de
 * teléfono son 2-4 MB— cinco mil son del orden de diez gigas de descargas, y la
 * lista de enlaces ya no se lee, se procesa.
 *
 * Lo que importa de este número no es cuál sea: es que lo que deja afuera se
 * DICE, en el paquete y en la respuesta. Un tope callado es peor que uno bajo.
 */
export const TOPE_ADJUNTOS = 5_000;

export async function exportarTenant(
  client: PoolClient,
  input: { tenantId: string; tope?: number },
): Promise<ExportacionTenant> {
  // Entero y acotado ANTES de acercarse al SQL. El tope se interpola en el
  // LIMIT —no puede ir como parámetro junto al resto en todas las bases— y
  // un `tope` que llegue como texto desde una query string sería una
  // inyección de manual. Tipar el parámetro no alcanza: TypeScript no está
  // del otro lado de un HTTP.
  const pedido = Math.floor(Number(input.tope ?? TOPE_POR_TABLA));
  const tope = Number.isFinite(pedido) ? Math.min(Math.max(1, pedido), TOPE_POR_TABLA) : TOPE_POR_TABLA;

  const t = await client.query('SELECT * FROM tenants WHERE id = $1', [input.tenantId]);
  if (t.rowCount === 0) throw new Error('No encontramos ese negocio.');

  const datos: Record<string, Array<Record<string, unknown>>> = {};
  const resumen: Record<string, number> = {};
  const truncadas: string[] = [];

  for (const tabla of TABLAS_EXPORTADAS) {
    /**
     * Una tabla que todavía no existe (módulo nunca migrado en este despliegue)
     * no es un error: se informa en cero y se sigue.
     *
     * «Y se sigue» es lo que el `.catch` pelado no conseguía: la primera tabla
     * ausente abortaba la transacción, así que las que quedaban del bucle
     * fallaban TODAS con `current transaction is aborted` y se informaban en
     * cero también. La exportación salía creíble y a medias, que en una
     * exportación de datos personales es el peor resultado (#966).
     */
    const leidas = await degradarSinRomper(
      client,
      (c) =>
        c
          .query(`SELECT * FROM ${tabla} WHERE tenant_id = $1 LIMIT ${tope + 1}`, [
            input.tenantId,
          ])
          .then((r) => r.rows as Array<Record<string, unknown>>),
      (error) => {
        console.warn(
          `organizations.exportación: no se pudo leer "${tabla}" de ${input.tenantId}; se informa ` +
            `en cero. Causa: ${error.message}`,
        );
        return [] as Array<Record<string, unknown>>;
      },
    );

    let filas = leidas;
    if (filas.length > tope) {
      filas = filas.slice(0, tope);
      truncadas.push(tabla);
    }
    const prohibidas = COLUMNAS_PROHIBIDAS[tabla];
    if (prohibidas) {
      filas = filas.map((fila) => {
        const copia = { ...fila };
        for (const col of prohibidas) delete copia[col];
        return copia;
      });
    }
    datos[tabla] = filas;
    resumen[tabla] = filas.length;
  }

  /**
   * Los adjuntos: la metadata, no las llaves peladas (#583).
   *
   * Los bytes viven en R2 y no viajan en el JSON —eso no cambió— pero lo que
   * sale de acá ya sirve para armar un paquete que se pueda abrir: el nombre con
   * el que se subió, de qué conversación es, cuánto pesa y de qué tipo es.
   *
   * El nombre importa más de lo que parece. La llave de R2 es
   * `<tenant>/<conversacion>/<timestamp>-<nombre-saneado>`: sin el nombre
   * original, el negocio recibe mil archivos con prefijos de máquina y no
   * reconoce ninguno. Un paquete que no se puede leer no es portabilidad.
   */
  const adjuntos: AdjuntoExportado[] = [];
  let adjuntosFuera = 0;
  for (const mensaje of datos.messages ?? []) {
    const lista = mensaje.attachments as Array<Record<string, unknown>> | null;
    if (!Array.isArray(lista)) continue;
    for (const a of lista) {
      const key = typeof a?.key === 'string' ? a.key : null;
      if (!key) continue;
      if (adjuntos.length >= TOPE_ADJUNTOS) {
        adjuntosFuera += 1;
        continue;
      }
      adjuntos.push({
        key,
        // `filename` es lo que mandó el navegador al subir; si no está, el
        // último tramo de la llave es lo más parecido a un nombre que hay.
        nombre: typeof a.filename === 'string' && a.filename ? a.filename : (key.split('/').pop() ?? key),
        conversationId: typeof mensaje.conversation_id === 'string' ? mensaje.conversation_id : null,
        messageId: typeof mensaje.id === 'string' ? mensaje.id : null,
        bytes: typeof a.sizeBytes === 'number' ? a.sizeBytes : null,
        contentType: typeof a.contentType === 'string' ? a.contentType : null,
      });
    }
  }

  return {
    tenant: t.rows[0],
    generadoEl: new Date().toISOString(),
    datos,
    resumen,
    truncadas,
    fuera: FUERA_DE_LA_EXPORTACION,
    adjuntos,
    adjuntosFuera,
  };
}
