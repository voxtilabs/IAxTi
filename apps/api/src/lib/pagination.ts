/**
 * Paginación por cursor (SPEC §28): límite máximo 100, cursor opaco
 * (base64url de un JSON con la última clave vista). Nunca offset.
 */
export interface PageParams {
  limit: number;
  cursor?: Record<string, string | number>;
}

export const MAX_LIMIT = 100;
export const DEFAULT_LIMIT = 25;

export function encodeCursor(key: Record<string, string | number>): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): Record<string, string | number> {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, string | number>;
  } catch {
    throw new CursorInvalidoError();
  }
}

export class CursorInvalidoError extends Error {
  readonly code = 'CURSOR_INVALID';
  constructor() {
    super('El cursor de paginación no es válido. Pide la primera página de nuevo, sin cursor.');
  }
}

export function parsePageParams(query: { limit?: string; cursor?: string }): PageParams {
  const rawLimit = Number(query.limit ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.trunc(rawLimit), 1), MAX_LIMIT)
    : DEFAULT_LIMIT;
  return {
    limit,
    cursor: query.cursor ? decodeCursor(query.cursor) : undefined,
  };
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Arma la página: pide limit+1 filas y usa la extra para saber si hay más. */
export function toPage<T>(rows: T[], limit: number, keyOf: (row: T) => Record<string, string | number>): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return {
    items,
    nextCursor: hasMore ? encodeCursor(keyOf(items[items.length - 1])) : null,
  };
}
