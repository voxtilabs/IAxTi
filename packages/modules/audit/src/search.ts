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
  /**
   * Desde dónde seguir, en la forma que devolvió la página anterior.
   *
   * Keyset sobre `(occurred_at, id)`, nunca offset: con `OFFSET 100` una fila
   * escrita entre las dos páginas corre todo y la 101 se salta. En un libro de
   * auditoría eso es una entrada que nadie ve jamás, y es justo la que se está
   * buscando cuando alguien pagina.
   */
  cursor?: string;
}

/**
 * El cursor: `occurred_at|id` en base64url.
 *
 * Opaco en el sentido de «no lo armes a mano»: la forma es nuestra y puede
 * cambiar. NO está firmado ni cifrado, y es deliberado — el `id` que lleva
 * adentro viene en cada fila de la respuesta, así que no expone nada que el
 * cliente no tenga ya. Firmarlo costaría una llave y su rotación para proteger
 * un dato que entregamos de todas formas.
 *
 * Manipularlo tampoco abre nada: el filtro por tenant y RLS se aplican igual,
 * así que lo más que consigue quien lo edite es empezar su propia página en
 * otro punto de los datos que ya podía leer.
 */
export function armarCursor(fila: { occurred_at: Date; id: string | number }): string {
  return Buffer.from(`${fila.occurred_at.toISOString()}|${fila.id}`).toString('base64url');
}

function leerCursor(cursor: string): { occurredAt: Date; id: string } | null {
  const [fecha, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!fecha || !id) return null;
  const occurredAt = new Date(fecha);
  return Number.isNaN(occurredAt.getTime()) ? null : { occurredAt, id };
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
  if (filter.cursor) {
    const desde = leerCursor(filter.cursor);
    // Un cursor ilegible se ignora en vez de reventar: lo peor que pasa es que
    // alguien vuelva a ver la primera página, y eso se nota. Un 400 por un
    // cursor viejo pegado en una URL sería peor que volver a empezar.
    if (desde) {
      params.push(desde.occurredAt, desde.id);
      // Por la TUPLA y no columna por columna, porque el orden es
      // `occurred_at DESC, id DESC`: con dos filas del mismo instante —y las
      // hay, porque una transacción escribe varias— comparar solo la fecha se
      // saltea las hermanas o las repite.
      // `::bigint` y no `::uuid`: el `id` de `audit_log` es
      // `bigint GENERATED ALWAYS AS IDENTITY`, no un uuid como el de casi
      // todas las otras tablas del repo. Con el cast equivocado Postgres
      // contesta «operator does not exist: bigint < uuid», que al menos es un
      // error ruidoso y no una página silenciosamente vacía.
      where.push(`(occurred_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::bigint)`);
    }
  }
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
/**
 * Una página, y desde dónde sigue la próxima.
 *
 * `siguiente` en `null` significa «no hay más» y se sabe de verdad: se piden
 * `tope + 1` filas y se devuelven `tope`. Deducirlo de «vinieron exactamente
 * 100, deben quedar más» obliga a una página vacía al final, y decir «hay más»
 * cuando no hay es tan malo como lo contrario: las dos hacen que nadie le
 * crea al «no hay más».
 */
async function pagina(
  client: PoolClient,
  filter: AuditFilter & { tenantId?: string },
  porDefecto: number,
) {
  const { where, params } = armarFiltro(filter);
  const tope = Math.min(filter.limit ?? porDefecto, POR_PAGINA);
  params.push(tope + 1);
  const result = await client.query(consulta(where, params.length), params);
  const hayMas = result.rows.length > tope;
  const filas = hayMas ? result.rows.slice(0, tope) : result.rows;
  return { filas, siguiente: hayMas ? armarCursor(filas[filas.length - 1]) : null };
}

export async function searchAudit(client: PoolClient, filter: AuditFilter = {}) {
  return (await pagina(client, filter, 50)).filas;
}

/**
 * Lo mismo, con el cursor de la página siguiente.
 *
 * Convive con `searchAudit` en vez de reemplazarla porque la forma de la
 * respuesta de `/v1` no se rompe —la regla de API dice que un cambio
 * incompatible abre `/v2`—. La ruta sigue devolviendo el array de siempre, y
 * la forma nueva va solo a quien la pide con `?cursor=`.
 */
export async function searchAuditPaginado(client: PoolClient, filter: AuditFilter = {}) {
  const { filas, siguiente } = await pagina(client, filter, 50);
  return { entries: filas, nextCursor: siguiente };
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
  return (await pagina(client, filter, POR_PAGINA)).filas;
}

export async function searchAuditGlobalPaginado(
  client: PoolClient,
  filter: AuditFilter & { tenantId?: string } = {},
) {
  const { filas, siguiente } = await pagina(client, filter, POR_PAGINA);
  return { entries: filas, nextCursor: siguiente };
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
