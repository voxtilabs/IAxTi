import type { PoolClient } from 'pg';
import { publishEvent } from '@iaxti/core';
import {
  assertTransicionPlantilla,
  normalizarNombre,
  puedeEnviarse,
  renderizar,
  validarPlantilla,
  variablesDe,
  type CategoriaPlantilla,
  type EstadoPlantilla,
  type PlantillaBorrador,
} from '../domain/plantillas';

/**
 * Plantillas de WhatsApp (#44): lo que se guarda, lo que se manda a aprobar
 * y lo que se puede enviar.
 *
 * El envío en sí sale por la MISMA cola que todo lo demás: una plantilla no
 * es un atajo para saltarse el consentimiento, el silencio ni el estado del
 * tenant. Lo único que se salta —y para eso existe— es la ventana de 24 h.
 */

export interface Plantilla {
  id: string;
  name: string;
  language: string;
  category: CategoriaPlantilla;
  header: string | null;
  body: string;
  footer: string | null;
  buttons: string[];
  status: EstadoPlantilla;
  providerId: string | null;
  rejectionReason: string | null;
  variables: number;
}

function aPlantilla(row: Record<string, unknown>): Plantilla {
  const body = row.body as string;
  const vars = variablesDe(body);
  return {
    id: row.id as string,
    name: row.name as string,
    language: row.language as string,
    category: row.category as CategoriaPlantilla,
    header: (row.header as string) ?? null,
    body,
    footer: (row.footer as string) ?? null,
    buttons: (row.buttons as string[]) ?? [],
    status: row.status as EstadoPlantilla,
    providerId: (row.provider_id as string) ?? null,
    rejectionReason: (row.rejection_reason as string) ?? null,
    variables: vars.length === 0 ? 0 : Math.max(...vars),
  };
}

export async function listTemplates(
  client: PoolClient,
  tenantId: string,
  filtro: { status?: EstadoPlantilla } = {},
): Promise<Plantilla[]> {
  const r = await client.query(
    filtro.status
      ? 'SELECT * FROM whatsapp_templates WHERE tenant_id = $1 AND status = $2 ORDER BY name'
      : 'SELECT * FROM whatsapp_templates WHERE tenant_id = $1 ORDER BY name',
    filtro.status ? [tenantId, filtro.status] : [tenantId],
  );
  return r.rows.map(aPlantilla);
}

export async function createTemplate(
  client: PoolClient,
  input: { tenantId: string } & PlantillaBorrador,
): Promise<Plantilla> {
  const name = normalizarNombre(input.name);
  validarPlantilla({ ...input, name });
  const r = await client
    .query(
      `INSERT INTO whatsapp_templates (tenant_id, name, language, category, header, body, footer, buttons)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) RETURNING *`,
      [
        input.tenantId,
        name,
        input.language,
        input.category,
        input.header?.trim() ?? null,
        input.body.trim(),
        input.footer?.trim() ?? null,
        JSON.stringify(input.buttons ?? []),
      ],
    )
    .catch((err: Error) => {
      if (err.message.includes('whatsapp_templates_tenant_id_name_language_key')) {
        throw new Error('Ya existe una plantilla con ese nombre en ese idioma.');
      }
      throw err;
    });
  return aPlantilla(r.rows[0]);
}

/**
 * Editar solo se puede en borrador o rechazada. Una aprobada que se toca
 * deja de ser la que Meta aprobó, y mandarla igual es mandar otra cosa con
 * el mismo nombre.
 */
export async function updateTemplate(
  client: PoolClient,
  input: { tenantId: string; templateId: string } & Partial<PlantillaBorrador>,
): Promise<Plantilla> {
  const actual = await getTemplate(client, input.tenantId, input.templateId);
  if (actual.status !== 'draft' && actual.status !== 'rejected') {
    throw new Error(
      `Una plantilla ${actual.status === 'pending' ? 'en revisión' : 'aprobada'} no se edita: duplícala y manda la nueva.`,
    );
  }
  const borrador: PlantillaBorrador = {
    name: input.name ? normalizarNombre(input.name) : actual.name,
    language: input.language ?? actual.language,
    category: input.category ?? actual.category,
    header: input.header !== undefined ? input.header : (actual.header ?? undefined),
    body: input.body ?? actual.body,
    footer: input.footer !== undefined ? input.footer : (actual.footer ?? undefined),
    buttons: input.buttons ?? actual.buttons,
  };
  validarPlantilla(borrador);

  const r = await client.query(
    `UPDATE whatsapp_templates
        SET name = $3, language = $4, category = $5, header = $6, body = $7,
            footer = $8, buttons = $9::jsonb, status = 'draft',
            rejection_reason = NULL, updated_at = now()
      WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [
      input.tenantId,
      input.templateId,
      borrador.name,
      borrador.language,
      borrador.category,
      borrador.header ?? null,
      borrador.body.trim(),
      borrador.footer ?? null,
      JSON.stringify(borrador.buttons ?? []),
    ],
  );
  return aPlantilla(r.rows[0]);
}

export async function getTemplate(
  client: PoolClient,
  tenantId: string,
  templateId: string,
): Promise<Plantilla> {
  const r = await client.query(
    'SELECT * FROM whatsapp_templates WHERE tenant_id = $1 AND id = $2',
    [tenantId, templateId],
  );
  if (r.rowCount === 0) throw new Error('Esa plantilla no existe en este negocio.');
  return aPlantilla(r.rows[0]);
}

/**
 * Marca la plantilla como mandada a revisión. El viaje al proveedor lo hace
 * quien tenga las llaves —el worker, con el adaptador del canal—; acá solo
 * se registra el paso, para que la interfaz no mienta diciendo "en revisión"
 * antes de que alguien la haya mandado de verdad.
 */
export async function marcarEnviadaARevision(
  client: PoolClient,
  input: { tenantId: string; templateId: string; providerId?: string; requestId?: string },
): Promise<Plantilla> {
  const actual = await getTemplate(client, input.tenantId, input.templateId);
  assertTransicionPlantilla(actual.status, 'pending');
  const r = await client.query(
    `UPDATE whatsapp_templates
        SET status = 'pending', provider_id = COALESCE($3, provider_id),
            submitted_at = now(), rejection_reason = NULL, updated_at = now()
      WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [input.tenantId, input.templateId, input.providerId ?? null],
  );
  await publishEvent(client, {
    name: 'template.submitted',
    tenantId: input.tenantId,
    payload: { templateId: input.templateId, name: actual.name },
    actor: 'system',
    requestId: input.requestId,
  });
  return aPlantilla(r.rows[0]);
}

/**
 * Lo que contestó Meta. Llega por webhook del proveedor y puede llegar en
 * cualquier momento: una plantilla aprobada hace meses se pausa sola si la
 * gente la reporta, y el negocio tiene que enterarse.
 */
export async function aplicarEstadoDelProveedor(
  client: PoolClient,
  input: {
    tenantId: string;
    name: string;
    language: string;
    status: EstadoPlantilla;
    reason?: string;
    providerId?: string;
    requestId?: string;
  },
): Promise<Plantilla | null> {
  const r0 = await client.query(
    'SELECT * FROM whatsapp_templates WHERE tenant_id = $1 AND name = $2 AND language = $3',
    [input.tenantId, input.name, input.language],
  );
  if (r0.rowCount === 0) return null; // una plantilla que no es nuestra: se ignora
  const actual = aPlantilla(r0.rows[0]);
  if (actual.status === input.status) return actual; // el mismo aviso dos veces
  assertTransicionPlantilla(actual.status, input.status);

  const r = await client.query(
    `UPDATE whatsapp_templates
        SET status = $3, rejection_reason = $4, provider_id = COALESCE($5, provider_id),
            reviewed_at = now(), updated_at = now()
      WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [input.tenantId, actual.id, input.status, input.reason ?? null, input.providerId ?? null],
  );
  await publishEvent(client, {
    name: 'template.status_changed',
    tenantId: input.tenantId,
    payload: {
      templateId: actual.id,
      name: actual.name,
      from: actual.status,
      to: input.status,
      motivo: input.reason ?? null,
    },
    actor: 'system',
    requestId: input.requestId,
  });
  return aPlantilla(r.rows[0]);
}

/**
 * El texto que va a leer la persona, con los valores puestos. Se rechaza
 * todo lo que no esté aprobado: mandar una plantilla en revisión la hace
 * fallar en el proveedor y el cliente ve un mensaje que nunca llegó.
 */
export async function prepararEnvio(
  client: PoolClient,
  input: { tenantId: string; templateId: string; valores: string[] },
): Promise<{ plantilla: Plantilla; texto: string }> {
  const plantilla = await getTemplate(client, input.tenantId, input.templateId);
  if (!puedeEnviarse(plantilla.status)) {
    const explicacion: Record<string, string> = {
      draft: 'todavía no se manda a revisión',
      pending: 'está en revisión de Meta',
      rejected: 'la rechazaron',
      paused: 'está pausada por calidad',
      disabled: 'está deshabilitada',
    };
    throw new Error(
      `La plantilla "${plantilla.name}" no se puede enviar: ${explicacion[plantilla.status]}.`,
    );
  }
  return { plantilla, texto: renderizar(plantilla.body, input.valores) };
}

/**
 * Manda una plantilla aprobada a una conversación, esté o no dentro de la
 * ventana de 24 h. Eso último es TODO el punto de que existan.
 *
 * Lo que NO se salta, y conviene decirlo porque la tentación es grande:
 *
 *  - el **consentimiento**: sin opt-in no sale nada, ni con plantilla;
 *  - el **horario de silencio** y la **pausa por calidad**, que los aplica
 *    la cola de salida porque el envío va marcado como iniciado por el
 *    negocio;
 *  - el **estado del tenant**: una cuenta en solo lectura no envía;
 *  - el **plan**, que decide si el módulo está disponible.
 *
 * Una plantilla no es un permiso para molestar: es un permiso para *poder*
 * escribir cuando la conversación se enfrió.
 */
export async function enviarPlantilla(
  client: PoolClient,
  input: {
    tenantId: string;
    conversationId: string;
    templateId: string;
    valores: string[];
    authorId?: string;
    requestId?: string;
  },
  deps: {
    puedeIniciar: (contactId: string) => Promise<boolean>;
    contactoDe: (conversationId: string) => Promise<string>;
    crearMensaje: (m: {
      tenantId: string;
      conversationId: string;
      body: string;
      authorId?: string;
      requestId?: string;
    }) => Promise<{ id: string }>;
  },
): Promise<{ messageId: string; texto: string; plantilla: Plantilla }> {
  const { plantilla, texto } = await prepararEnvio(client, {
    tenantId: input.tenantId,
    templateId: input.templateId,
    valores: input.valores,
  });

  const contactId = await deps.contactoDe(input.conversationId);
  if (!(await deps.puedeIniciar(contactId))) {
    throw new Error('SIN_CONSENTIMIENTO');
  }

  const mensaje = await deps.crearMensaje({
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    body: texto,
    authorId: input.authorId,
    requestId: input.requestId,
  });

  // La plantilla queda pegada al MENSAJE: el adaptador la necesita para
  // mandarla como plantilla y no como texto, y un reintento de la cola tiene
  // que mandar exactamente la misma.
  await client.query(
    `UPDATE messages
        SET type = 'plantilla',
            meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object('plantilla', $3::jsonb)
      WHERE tenant_id = $1 AND id = $2`,
    [
      input.tenantId,
      mensaje.id,
      JSON.stringify({
        id: plantilla.id,
        name: plantilla.name,
        language: plantilla.language,
        category: plantilla.category,
        valores: input.valores,
      }),
    ],
  );

  await publishEvent(client, {
    name: 'template.sent',
    tenantId: input.tenantId,
    payload: {
      templateId: plantilla.id,
      name: plantilla.name,
      conversationId: input.conversationId,
      messageId: mensaje.id,
    },
    actor: input.authorId ?? 'system',
    requestId: input.requestId,
  });

  return { messageId: mensaje.id, texto, plantilla };
}
