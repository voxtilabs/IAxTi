import type { PoolClient } from 'pg';

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
  audit_log:
    'Tiene su propia exportación firmada y encadenada (#72): meterla acá sin la firma la degrada.',
  outbox: 'Cola de eventos: mecánica nuestra, no datos del negocio.',
  processed_events: 'Idem outbox.',
  idempotency_keys: 'Llaves de reintento con vida de 24 h; fuera de ese momento no significan nada.',
  knowledge_query_cache: 'Caché: se reconstruye sola y no es información nueva.',
  platform_support_sessions: 'Registro NUESTRO de cuándo miramos su cuenta; no es dato suyo.',
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
  'channel_accounts',
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
  /** Llaves de los adjuntos en R2: los archivos se piden aparte. */
  adjuntos: string[];
}

/** Tope por tabla, para que un tenant enorme no voltee el proceso. */
export const TOPE_POR_TABLA = 50_000;

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
    // Una tabla que todavía no existe (módulo nunca migrado en este
    // despliegue) no es un error: se informa en cero y se sigue.
    const r = await client
      .query(`SELECT * FROM ${tabla} WHERE tenant_id = $1 LIMIT ${tope + 1}`, [input.tenantId])
      .catch(() => ({ rows: [] as Array<Record<string, unknown>> }));

    let filas = r.rows as Array<Record<string, unknown>>;
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

  // Los adjuntos viven en R2 y no viajan en el JSON: acá van sus llaves para
  // que se puedan pedir. Bajarlos y empaquetarlos es un paso aparte.
  const adjuntos: string[] = [];
  for (const mensaje of datos.messages ?? []) {
    const lista = mensaje.attachments as Array<{ key?: string }> | null;
    if (Array.isArray(lista)) {
      for (const a of lista) if (a?.key) adjuntos.push(a.key);
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
  };
}
