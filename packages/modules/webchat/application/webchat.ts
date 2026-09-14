import type { PoolClient } from 'pg';
import { createChannelAccount, setChannelState } from '@iaxti/module-channels';
import type { ChannelProvider } from '@iaxti/module-channels';
import { autoAssignNew, receiveInboundForContact } from '@iaxti/module-conversations';
import { ensureWebContact } from '@iaxti/module-crm';

// webchat (#46, SPEC §12): el widget propio. Mismo modelo de conversación,
// misma bandeja — el equipo solo ve otro ícono de canal. La entrega al
// visitante es por sondeo del widget (no hay webhook de vuelta).

export const webchatProvider: ChannelProvider = {
  kind: 'webchat',
  // El visitante recibe por el sondeo del widget: entregado al escribirlo.
  async send(_account, message) {
    return { providerMessageId: `wc-out-${Buffer.from(JSON.stringify(message)).length}-${Math.abs(hash(JSON.stringify(message)))}` };
  },
  verifyWebhook: () => false, // el webchat no recibe webhooks
  normalize: () => [],
};

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

export interface Widget {
  id: string;
  tenantId: string;
  channelAccountId: string;
  name: string;
  allowedDomain: string;
  welcomeMessage: string;
  active: boolean;
}

function rowToWidget(row: Record<string, unknown>): Widget {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    channelAccountId: row.channel_account_id as string,
    name: row.name as string,
    allowedDomain: row.allowed_domain as string,
    welcomeMessage: row.welcome_message as string,
    active: row.active as boolean,
  };
}

export async function createWidget(
  client: PoolClient,
  input: { tenantId: string; allowedDomain: string; name?: string; welcomeMessage?: string },
): Promise<Widget> {
  const dominio = input.allowedDomain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!dominio) throw new Error('Dinos el dominio del sitio donde vivirá el chat.');
  const account = await createChannelAccount(client, {
    tenantId: input.tenantId,
    kind: 'webchat',
    name: input.name ?? 'Chat del sitio',
  });
  await setChannelState(client, { tenantId: input.tenantId, accountId: account.id, state: 'active' });
  const r = await client.query(
    `INSERT INTO webchat_widgets (tenant_id, channel_account_id, name, allowed_domain, welcome_message)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [
      input.tenantId,
      account.id,
      input.name ?? 'Chat del sitio',
      dominio,
      input.welcomeMessage ?? '¡Hola! ¿En qué te podemos ayudar?',
    ],
  );
  return rowToWidget(r.rows[0]);
}

export async function listWidgets(client: PoolClient, tenantId: string): Promise<Widget[]> {
  const r = await client.query(
    'SELECT * FROM webchat_widgets WHERE tenant_id = $1 ORDER BY created_at',
    [tenantId],
  );
  return r.rows.map(rowToWidget);
}

/** Apagar desactiva el widget (nada entra); el historial en la bandeja queda. */
export async function setWidgetActive(
  client: PoolClient,
  input: { tenantId: string; widgetId: string; active: boolean },
): Promise<Widget> {
  const r = await client.query(
    `UPDATE webchat_widgets SET active = $3, updated_at = now()
      WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [input.tenantId, input.widgetId, input.active],
  );
  if (r.rowCount === 0) throw new Error('No encontramos ese widget.');
  return rowToWidget(r.rows[0]);
}

/** Lookup público por token del snippet (el webhook path: sin tenant previo). */
export async function findWidgetById(client: PoolClient, widgetId: string): Promise<Widget | null> {
  const r = await client.query('SELECT * FROM webchat_widgets WHERE id = $1', [widgetId]);
  return r.rowCount === 0 ? null : rowToWidget(r.rows[0]);
}

export function domainAllowed(widget: Widget, referrerOrOrigin: string | undefined): boolean {
  if (!referrerOrOrigin) return false;
  try {
    const host = new URL(referrerOrOrigin).hostname.toLowerCase();
    return host === widget.allowedDomain || host.endsWith(`.${widget.allowedDomain}`);
  } catch {
    return false;
  }
}

export interface Session {
  id: string;
  tenantId: string;
  widgetId: string;
  contactId: string | null;
  conversationId: string | null;
  visitorName: string | null;
  pending: Array<{ body: string; at: string }>;
}

function rowToSession(row: Record<string, unknown>): Session {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    widgetId: row.widget_id as string,
    contactId: (row.contact_id as string) ?? null,
    conversationId: (row.conversation_id as string) ?? null,
    visitorName: (row.visitor_name as string) ?? null,
    pending: (row.pending as Session['pending']) ?? [],
  };
}

export async function startSession(
  client: PoolClient,
  input: { tenantId: string; widgetId: string },
): Promise<Session> {
  const r = await client.query(
    'INSERT INTO webchat_sessions (tenant_id, widget_id) VALUES ($1, $2) RETURNING *',
    [input.tenantId, input.widgetId],
  );
  return rowToSession(r.rows[0]);
}

export async function getSession(
  client: PoolClient,
  tenantId: string,
  widgetId: string,
  sessionId: string,
): Promise<Session | null> {
  const r = await client.query(
    'SELECT * FROM webchat_sessions WHERE tenant_id = $1 AND widget_id = $2 AND id = $3 FOR UPDATE',
    [tenantId, widgetId, sessionId],
  );
  return r.rowCount === 0 ? null : rowToSession(r.rows[0]);
}

export interface VisitorMessageResult {
  status: 'pending' | 'need_identity' | 'delivered';
  conversationId?: string;
}

/**
 * El mensaje del visitante. El PRIMERO puede ser anónimo (queda en la
 * sesión); antes del segundo se identifica con nombre y teléfono o correo
 * (SPEC §12) — ahí nace o se enlaza el contacto, se abre la conversación
 * en la MISMA bandeja y lo pendiente se vuelca en orden.
 */
export async function postVisitorMessage(
  client: PoolClient,
  input: {
    widget: Widget;
    sessionId: string;
    body: string;
    visitor?: { name?: string; phone?: string; email?: string };
    requestId?: string;
  },
): Promise<VisitorMessageResult> {
  const { widget } = input;
  if (!input.body?.trim()) throw new Error('Escribe el mensaje primero.');
  const session = await getSession(client, widget.tenantId, widget.id, input.sessionId);
  if (!session) throw new Error('La sesión del chat expiró. Recarga la página.');

  const entregar = async (conversationId: string | null, contactId: string, textos: string[]) => {
    let conv = conversationId;
    for (const texto of textos) {
      const res = await receiveInboundForContact(client, {
        tenantId: widget.tenantId,
        contactId,
        channel: 'webchat',
        channelAccountId: widget.channelAccountId,
        body: texto,
        requestId: input.requestId,
      });
      conv = res.conversation.id;
      if (res.conversationCreated) {
        await autoAssignNew(client, {
          tenantId: widget.tenantId,
          conversationId: conv,
          requestId: input.requestId,
        });
      }
    }
    return conv!;
  };

  // Ya identificada: directo a la bandeja.
  if (session.contactId) {
    const conversationId = await entregar(session.conversationId, session.contactId, [input.body]);
    await client.query(
      `UPDATE webchat_sessions SET conversation_id = $3, updated_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [widget.tenantId, session.id, conversationId],
    );
    return { status: 'delivered', conversationId };
  }

  // Con identidad en la mano: contacto + conversación + flush de pendientes.
  if (input.visitor && (input.visitor.phone?.trim() || input.visitor.email?.trim())) {
    const { contact } = await ensureWebContact(client, {
      tenantId: widget.tenantId,
      name: input.visitor.name,
      phone: input.visitor.phone,
      email: input.visitor.email,
      requestId: input.requestId,
    });
    const textos = [...session.pending.map((m) => m.body), input.body];
    const conversationId = await entregar(null, contact.id, textos);
    await client.query(
      `UPDATE webchat_sessions SET contact_id = $3, conversation_id = $4,
              visitor_name = $5, pending = '[]'::jsonb, updated_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [widget.tenantId, session.id, contact.id, conversationId, input.visitor.name ?? null],
    );
    return { status: 'delivered', conversationId };
  }

  // Anónimo: el primero espera en la sesión; del segundo en adelante,
  // identidad o nada (el widget muestra el formulario).
  if (session.pending.length >= 1) return { status: 'need_identity' };
  await client.query(
    `UPDATE webchat_sessions SET pending = pending || $3::jsonb, updated_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [widget.tenantId, session.id, JSON.stringify([{ body: input.body, at: new Date().toISOString() }])],
  );
  return { status: 'pending' };
}

/** Las respuestas del equipo para el sondeo del widget. */
export async function getSessionReplies(
  client: PoolClient,
  input: { widget: Widget; sessionId: string; afterIso?: string },
): Promise<Array<{ id: string; body: string | null; createdAt: Date }>> {
  const session = await getSession(client, input.widget.tenantId, input.widget.id, input.sessionId);
  if (!session?.conversationId) return [];
  const params: unknown[] = [input.widget.tenantId, session.conversationId];
  let after = '';
  if (input.afterIso) {
    params.push(input.afterIso);
    // El cursor viaja como ISO (milisegundos): se trunca lo almacenado
    // (microsegundos de pg) para que el propio último no se repita.
    after = `AND date_trunc('milliseconds', created_at) > $3::timestamptz`;
  }
  const r = await client.query(
    `SELECT id, body, created_at FROM messages
      WHERE tenant_id = $1 AND conversation_id = $2 AND direction = 'out' ${after}
      ORDER BY seq`,
    params,
  );
  return r.rows.map((row) => ({ id: row.id, body: row.body ?? null, createdAt: row.created_at }));
}
