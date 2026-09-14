import type { PoolClient } from 'pg';
import { publishEvent } from '@iaxti/core';
import { extractMentions } from '../domain/plantillas';

// Quick replies, notas internas y búsqueda (#39, SPEC §11).

export interface QuickReply {
  id: string;
  shortcut: string;
  body: string;
  /** null = del negocio; si no, personal de ese usuario. */
  userId: string | null;
}

export async function createQuickReply(
  client: PoolClient,
  input: { tenantId: string; shortcut: string; body: string; userId?: string },
): Promise<QuickReply> {
  const shortcut = input.shortcut.trim().toLowerCase().replace(/^\//, '');
  if (!shortcut || !input.body.trim()) {
    throw new Error('El atajo necesita nombre y texto.');
  }
  try {
    const r = await client.query(
      `INSERT INTO quick_replies (tenant_id, user_id, shortcut, body)
       VALUES ($1, $2, $3, $4) RETURNING id, user_id, shortcut, body`,
      [input.tenantId, input.userId ?? null, shortcut, input.body],
    );
    const row = r.rows[0];
    return { id: row.id, shortcut: row.shortcut, body: row.body, userId: row.user_id ?? null };
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new Error(`Ya existe un atajo "${shortcut}". Elige otro nombre.`);
    }
    throw err;
  }
}

/** Los del negocio más los personales de quien pregunta, por atajo. */
export async function listQuickReplies(
  client: PoolClient,
  tenantId: string,
  userId: string,
): Promise<QuickReply[]> {
  const r = await client.query(
    `SELECT id, user_id, shortcut, body FROM quick_replies
      WHERE tenant_id = $1 AND (user_id IS NULL OR user_id = $2)
      ORDER BY shortcut`,
    [tenantId, userId],
  );
  return r.rows.map((row) => ({
    id: row.id,
    shortcut: row.shortcut,
    body: row.body,
    userId: row.user_id ?? null,
  }));
}

export async function deleteQuickReply(
  client: PoolClient,
  input: { tenantId: string; id: string; userId?: string },
): Promise<void> {
  // Sin permiso de manage solo se borran los propios (el caso de uso decide).
  const r = input.userId
    ? await client.query(
        'DELETE FROM quick_replies WHERE tenant_id = $1 AND id = $2 AND user_id = $3',
        [input.tenantId, input.id, input.userId],
      )
    : await client.query('DELETE FROM quick_replies WHERE tenant_id = $1 AND id = $2', [
        input.tenantId,
        input.id,
      ]);
  if (r.rowCount === 0) throw new Error('No encontramos ese atajo, o no es tuyo.');
}

export interface InternalNote {
  id: string;
  conversationId: string;
  authorId: string;
  body: string;
  mentions: string[];
  createdAt: Date;
}

function rowToNote(row: Record<string, unknown>): InternalNote {
  return {
    id: row.id as string,
    conversationId: row.conversation_id as string,
    authorId: row.author_id as string,
    body: row.body as string,
    mentions: (row.mentions as string[]) ?? [],
    createdAt: row.created_at as Date,
  };
}

/**
 * Nota visible SOLO para el equipo (tabla aparte de messages: imposible
 * enviarla por error a un canal). `mentions` llega resuelta a ids de usuario
 * por la UI; los @texto sin resolver quedan en el cuerpo.
 */
export async function addInternalNote(
  client: PoolClient,
  input: {
    tenantId: string;
    conversationId: string;
    authorId: string;
    body: string;
    mentions?: string[];
  },
): Promise<InternalNote> {
  if (!input.body.trim()) throw new Error('Escribe la nota antes de guardarla.');
  const r = await client.query(
    `INSERT INTO internal_notes (tenant_id, conversation_id, author_id, body, mentions)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [input.tenantId, input.conversationId, input.authorId, input.body, input.mentions ?? []],
  );
  const nota = rowToNote(r.rows[0]);
  // La mención avisa (#55): notifications lo convierte en campana/correo.
  if (nota.mentions.length > 0) {
    await publishEvent(client, {
      name: 'note.mentioned',
      tenantId: input.tenantId,
      payload: {
        noteId: nota.id,
        conversationId: input.conversationId,
        mentions: nota.mentions,
        excerpt: input.body.slice(0, 120),
      },
      actor: input.authorId,
    });
  }
  return nota;
}

export async function listInternalNotes(
  client: PoolClient,
  tenantId: string,
  conversationId: string,
): Promise<InternalNote[]> {
  const r = await client.query(
    `SELECT * FROM internal_notes
      WHERE tenant_id = $1 AND conversation_id = $2 ORDER BY created_at`,
    [tenantId, conversationId],
  );
  return r.rows.map(rowToNote);
}

export { extractMentions };

export interface SearchHit {
  kind: 'mensaje' | 'nota';
  conversationId: string;
  contactName: string | null;
  contactPhone: string;
  /** Fragmento con la coincidencia destacada (<b>…</b> de ts_headline). */
  snippet: string;
  createdAt: Date;
}

/**
 * Búsqueda de texto completo por tenant sobre mensajes (incluida la futura
 * transcripción de audios) y notas internas (SPEC §11). Español, RLS activa.
 * `ownerScope` limita a las conversaciones propias o sin dueño cuando quien
 * busca no tiene `conversations.read_all`.
 */
export async function searchConversations(
  client: PoolClient,
  input: { tenantId: string; query: string; ownerScope?: string; limit?: number },
): Promise<SearchHit[]> {
  const q = input.query.trim();
  if (!q) return [];
  const limit = Math.min(input.limit ?? 20, 50);
  const params: unknown[] = [input.tenantId, q, limit];
  let owner = '';
  if (input.ownerScope) {
    params.push(input.ownerScope);
    owner = `AND (c.owner_id = $4 OR c.owner_id IS NULL)`;
  }
  const r = await client.query(
    `SELECT * FROM (
       SELECT 'mensaje' AS kind, c.id AS conversation_id, k.name AS contact_name,
              k.phone AS contact_phone, m.created_at,
              ts_headline('spanish', coalesce(m.body, ''), plainto_tsquery('spanish', $2)) AS snippet,
              ts_rank(m.search, plainto_tsquery('spanish', $2)) AS rank
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         JOIN contacts k ON k.id = c.contact_id
        WHERE m.tenant_id = $1 AND m.search @@ plainto_tsquery('spanish', $2) ${owner}
       UNION ALL
       SELECT 'nota', c.id, k.name, k.phone, n.created_at,
              ts_headline('spanish', n.body, plainto_tsquery('spanish', $2)),
              ts_rank(n.search, plainto_tsquery('spanish', $2))
         FROM internal_notes n
         JOIN conversations c ON c.id = n.conversation_id
         JOIN contacts k ON k.id = c.contact_id
        WHERE n.tenant_id = $1 AND n.search @@ plainto_tsquery('spanish', $2) ${owner}
     ) hits
     ORDER BY rank DESC, created_at DESC
     LIMIT $3`,
    params,
  );
  return r.rows.map((row) => ({
    kind: row.kind,
    conversationId: row.conversation_id,
    contactName: row.contact_name ?? null,
    contactPhone: row.contact_phone,
    snippet: row.snippet,
    createdAt: row.created_at,
  }));
}
