import type { PoolClient } from 'pg';
import type { ActorKind } from './write';

export interface AuditFilter {
  actor?: string;
  actorKind?: ActorKind;
  action?: string;
  resource?: string;
  /** Desde dónde se hizo: es la mitad de las preguntas de un auditor. */
  ip?: string;
  result?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}

/**
 * El WHERE del libro, en UN solo lugar.
 *
 * Estaba escrito dos veces, igual columna por columna, en la búsqueda del
 * tenant y en la del SuperAdmin. Y las dos copias ya se habían separado donde
 * importaba: el tope de filas. La del tenant cortaba en 100 y la global en
 * 1000, así que el export del libro de UN tenant daba distinto según quién lo
 * pidiera — y el que devolvía menos era el del dueño del dato (#798).
 */
function armarFiltro(filter: AuditFilter & { tenantId?: string }): {
  where: string[];
  params: unknown[];
} {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace('?', `$${params.length}`));
  };

  if (filter.tenantId) add('tenant_id = ?', filter.tenantId);
  if (filter.actor) add('actor = ?', filter.actor);
  if (filter.actorKind) add('actor_kind = ?', filter.actorKind);
  if (filter.action) add('action = ?', filter.action);
  if (filter.resource) add('resource = ?', filter.resource);
  if (filter.ip) add('host(ip) = ?', filter.ip);
  if (filter.result) add('result = ?', filter.result);
  if (filter.from) add('occurred_at >= ?', filter.from);
  if (filter.to) add('occurred_at <= ?', filter.to);
  return { where, params };
}

const COLUMNAS = `id, tenant_id, actor, actor_kind, action, resource, resource_id,
           occurred_at, result, host(ip) AS ip, request_id, metadata`;

function consulta(where: string[], posicionDelTope: number): string {
  return `
    SELECT ${COLUMNAS}
      FROM audit_log
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY occurred_at DESC, id DESC
      LIMIT $${posicionDelTope}`;
}

/** Una página de la búsqueda; el tope lo fija la regla de API (api.md). */
const POR_PAGINA = 100;

/** Búsqueda dentro del tenant en contexto (RLS acota; permiso audit.read). */
export async function searchAudit(client: PoolClient, filter: AuditFilter = {}) {
  const { where, params } = armarFiltro(filter);
  params.push(Math.min(filter.limit ?? 50, POR_PAGINA));
  const result = await client.query(consulta(where, params.length), params);
  return result.rows;
}

/**
 * La misma búsqueda, para el SuperAdmin (#72): cruza tenants a propósito, así
 * que corre con el pool de servicio —sin RLS— y exige el permiso
 * `platform.audit`. El filtro por tenant es opcional; sin él, se ve todo.
 */
export async function searchAuditGlobal(
  client: PoolClient,
  filter: AuditFilter & { tenantId?: string } = {},
) {
  const { where, params } = armarFiltro(filter);
  params.push(Math.min(filter.limit ?? POR_PAGINA, POR_PAGINA));
  const result = await client.query(consulta(where, params.length), params);
  return result.rows;
}

/**
 * Cuántas entradas puede llevarse un export de una vez.
 *
 * No es un número de producto: es cuánto aguanta una respuesta en memoria. Si
 * el filtro alcanza más que esto, el export se RECHAZA y se pide acotar el
 * rango. No se recorta.
 */
export const TOPE_EXPORT = 50_000;

/** El filtro alcanza más de lo que cabe en un export. */
export class ExportDemasiadoGrande extends Error {
  constructor(readonly tope: number = TOPE_EXPORT) {
    super(`El libro filtrado supera las ${tope} entradas que caben en un export.`);
    this.name = 'ExportDemasiadoGrande';
  }
}

/**
 * El libro COMPLETO para el rango pedido, o nada.
 *
 * ## Por qué no es `searchAudit` con un límite más alto
 *
 * Porque un export de auditoría es el artefacto de cumplimiento: es lo que se
 * entrega cuando alguien pregunta «quién cambió esto». Antes de esto, la ruta
 * de export pedía hasta mil filas con defecto mil, `searchAudit` las cortaba
 * en cien, y el documento salía **firmado** sobre esas cien, sin un campo que
 * dijera que faltaba el resto y sin forma de pedir la página siguiente.
 *
 * Un libro truncado con firma correcta se lee como completo. Eso es peor que
 * un export que falla: el que falla se vuelve a pedir.
 *
 * Y no alcanzaba con marcar el truncamiento al lado de la firma, porque la
 * firma cubre el contenido y no la marca: una marca fuera de lo firmado se
 * puede quitar y el documento sigue verificando. Entonces el export es
 * completo por construcción, o no existe.
 *
 * ## Cómo sabe que no cabe
 *
 * Pide una fila más que el tope. Si vuelven, el filtro alcanza más de lo que
 * cabe y se rechaza — sin un `count(*)` aparte, que además podría contar algo
 * distinto de lo que después se trae.
 */
export async function exportAudit(
  client: PoolClient,
  filter: AuditFilter & { tenantId?: string } = {},
  tope: number = TOPE_EXPORT,
): Promise<Record<string, unknown>[]> {
  const { where, params } = armarFiltro(filter);
  params.push(tope + 1);
  const result = await client.query(consulta(where, params.length), params);
  if (result.rows.length > tope) throw new ExportDemasiadoGrande(tope);
  return result.rows;
}
