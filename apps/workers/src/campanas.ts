import type { Pool, PoolClient } from 'pg';
import { withTenant } from '@iaxti/db';
import {
  campanasSinAvance,
  enviarLoteDeCampana,
  LOTE_POR_DEFECTO,
  type EstadoDelLote,
} from '@iaxti/module-automations';
import { canReceiveBusinessInitiated } from '@iaxti/module-crm';
import { sendMessage } from '@iaxti/module-conversations';
import { enviarPlantilla, MOTIVO_TOPE_DIARIO, numeroEnRojo } from '@iaxti/module-whatsapp';

/**
 * Una campaña sale por lotes desde acá, no desde el request (#609, #610).
 *
 * ## Qué cambió y por qué
 *
 * `POST /campanas/:id/enviar` recorría el segmento completo dentro del propio
 * request HTTP y dentro de un único `BEGIN/COMMIT`. De ahí salían tres cosas a
 * la vez, y las tres son del mismo origen:
 *
 *  1. 900 contactos en un request es un timeout esperando ocurrir.
 *  2. El tope diario del canal cortaba a mitad de camino, el resto quedaba
 *     `failed` y **la campaña se reportaba como enviada**: el dueño veía
 *     «enviada, 900» y 650 personas nunca recibieron nada. Después llamaba a
 *     preguntar por qué nadie respondió la promoción.
 *  3. No existía ningún punto donde consultar si alguien pidió parar, así que
 *     `cancelled` estaba en el esquema y nada lo escribía nunca.
 *
 * ## Un lote por job, y el job se vuelve a encolar
 *
 * Podría ser un `while` acá dentro y es a propósito que no lo sea. Encolar de
 * nuevo después de cada lote da tres cosas gratis:
 *
 *  · **Equidad entre negocios.** Una campaña de 10.000 no deja esperando la de
 *    80 del negocio de al lado: los lotes se intercalan.
 *  · **Reintento con el backoff de la cola.** Si la base parpadea a mitad del
 *    lote 14, se reintenta el lote 14, no la campaña entera. Y no le vuelve a
 *    mandar a quien ya tiene fila, porque el cursor es la tabla de
 *    destinatarios y el `ON CONFLICT` la protege.
 *  · **Un worker que se puede apagar.** Un `while` de media hora no se entera
 *    del apagado ordenado; un lote sí termina.
 */

export interface JobDeCampana {
  moduleId: 'automations';
  tenantId: string;
  campaignId: string;
  actor?: string;
  actorKind?: 'user' | 'apikey' | 'system';
  requestId?: string;
}

/**
 * Lo que la campaña necesita del resto del sistema.
 *
 * Vive acá y SOLO acá. Antes estaba escrito en el controller, porque el envío
 * corría en el request; dejarlo en los dos lados sería la receta conocida —una
 * lectura en cada lugar, y la que se corrige es una sola—, así que el
 * controller dejó de construirlo cuando dejó de mandar.
 */
function depsDeCampana(c: PoolClient, job: JobDeCampana) {
  const actorKind = job.actorKind === 'apikey' ? 'apikey' : 'user';
  return {
    calidadDelNumero: async () =>
      (await numeroEnRojo(c, job.tenantId)) ? ('rojo' as const) : ('verde' as const),
    puedeIniciar: (contactId: string) => canReceiveBusinessInitiated(c, job.tenantId, contactId),
    /**
     * ¿El canal rechazó por tope algo de esta campaña? (#609)
     *
     * Vive acá y no en `automations` porque la respuesta depende de cómo el
     * adaptador del canal guarda sus rechazos —`messages.meta->>'error'`, con la
     * causa ya traducida— y eso es conocimiento de `whatsapp`, no de las
     * automatizaciones. La frase se compara contra la constante que el propio
     * módulo exporta: así, el día que alguien mejore la redacción, esto sigue
     * calzando en vez de dejar de cortar en silencio.
     */
    canalLleno: async () => {
      const r = await c.query(
        `SELECT m.meta->>'error' AS motivo
           FROM campaign_recipients r
           JOIN messages m ON m.tenant_id = r.tenant_id AND m.id = r.message_id
          WHERE r.tenant_id = $1 AND r.campaign_id = $2
            AND m.delivery_status = 'failed'
            AND m.meta->>'error' = $3
          LIMIT 1`,
        [job.tenantId, job.campaignId, MOTIVO_TOPE_DIARIO],
      );
      return (r.rows[0]?.motivo as string) ?? null;
    },
    datosDelContacto: async (contactId: string) => {
      const r = await c.query('SELECT name, phone FROM contacts WHERE tenant_id = $1 AND id = $2', [
        job.tenantId,
        contactId,
      ]);
      return r.rows[0] ?? {};
    },
    conversacionDe: async (contactId: string) => {
      const r = await c.query(
        `SELECT id FROM conversations
          WHERE tenant_id = $1 AND contact_id = $2 AND channel = 'whatsapp'
          ORDER BY last_message_at DESC NULLS LAST LIMIT 1`,
        [job.tenantId, contactId],
      );
      return (r.rows[0]?.id as string) ?? null;
    },
    enviarPlantilla: async ({
      conversationId,
      contactId,
      templateId,
      valores,
    }: {
      conversationId: string;
      contactId: string;
      templateId: string;
      valores: string[];
    }) => {
      const env = await enviarPlantilla(
        c,
        {
          tenantId: job.tenantId,
          conversationId,
          templateId,
          valores,
          authorId: job.actor,
          requestId: job.requestId,
        },
        {
          contactoDe: async () => contactId,
          puedeIniciar: () => canReceiveBusinessInitiated(c, job.tenantId, contactId),
          crearMensaje: (m) =>
            sendMessage(c, {
              tenantId: m.tenantId,
              conversationId: m.conversationId,
              authorKind: 'user',
              authorId: m.authorId,
              body: m.body,
              requestId: m.requestId,
              delivery: 'business',
              actorKind,
            }),
        },
      );
      return { messageId: env.messageId };
    },
  };
}

/**
 * Manda el lote siguiente. Devuelve el estado para que quien llama decida si
 * vuelve a encolar.
 *
 * Cada lote va en su propia transacción. Eso es deliberado y es la mitad del
 * arreglo: una transacción que abarcara la campaña entera no deja ver el avance
 * desde afuera —el dueño no vería «250 de 900» hasta el final— ni permite que
 * `detenerCampana` escriba su solicitud y que este lote la lea.
 */
export async function procesarLoteDeCampana(
  pool: Pool,
  job: JobDeCampana,
  lote = LOTE_POR_DEFECTO,
): Promise<EstadoDelLote> {
  return withTenant(pool, job.tenantId, (c) =>
    enviarLoteDeCampana(
      c,
      {
        tenantId: job.tenantId,
        campaignId: job.campaignId,
        lote,
        actor: job.actor,
        actorKind: job.actorKind,
        requestId: job.requestId,
      },
      depsDeCampana(c, job),
    ),
  );
}

/**
 * Las campañas que dicen «saliendo» y no avanzan, para volverlas a encolar.
 *
 * A QUIÉN visitar se pregunta UNA vez, con una función SECURITY DEFINER
 * (ADR-0026): `campaigns` tiene RLS y una consulta cross-tenant con el rol de la
 * aplicación devuelve CERO filas (#286) — el barrido se vería corriendo y no
 * encontraría nada nunca.
 *
 * Volver a encolar es seguro: el candado de lote impide que dos salgan juntas, y
 * el cursor es la tabla de destinatarios, así que a nadie se le manda dos veces.
 */
export async function campanasPorReencolar(
  pool: Pool,
  minutos = 10,
): Promise<JobDeCampana[]> {
  const tenants = (
    await pool.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM tenants_con_campanas_sin_avance($1)',
      [minutos],
    )
  ).rows.map((f) => f.tenant_id);

  const jobs: JobDeCampana[] = [];
  for (const tenantId of tenants) {
    const ids = await withTenant(pool, tenantId, (c) => campanasSinAvance(c, tenantId, minutos));
    // Sin `actor`: el barrido no es nadie. La auditoría del cierre va a decir
    // `system`, que es la verdad — quien la lanzó ya quedó en `campaign.started`.
    for (const campaignId of ids) jobs.push({ moduleId: 'automations', tenantId, campaignId });
  }
  return jobs;
}
