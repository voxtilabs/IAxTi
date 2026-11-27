import type { PoolClient } from 'pg';
import { publishEvent } from '@iaxti/core';
import { writeAudit } from '@iaxti/module-audit';
import { processSource, rowToSource, type ProcessPorts, type Source } from './sources';

/**
 * La fuente «por revisar» de lo aprendido de los chats (#1406, ADR-0039).
 *
 * Lo que el job de workers aprende de los chats del negocio NO entra al
 * conocimiento como entra un texto pegado: nace en estado `por_revisar`,
 * que la búsqueda del asistente no lee (`FUENTE_VIGENTE` exige `active`), y
 * la dueña lo revisa entrada por entrada antes de que exista para la IA.
 *
 * ## Dónde vive el contenido, y por qué con esa forma
 *
 * En `sources.content`, igual que toda fuente `faq`: un JSON. La diferencia
 * es que mientras está por revisar trae una envoltura —
 * `{ tono, entradas: [...] }` — porque hay dos cosas que el formato `faq` de
 * siempre no tiene dónde poner: el TONO del negocio y, por entrada, el TIPO,
 * la FECHA del chat y el AVISO de precio («visto en un chat del dd-mm;
 * confírmalo»). Al APROBAR, la envoltura se abre: el contenido pasa al
 * array `[{q, a}]` de siempre y entra por `processSource` — el mismo camino
 * de embeddings que cualquier FAQ, sin un indexador nuevo.
 *
 * Cada entrada lleva un `id` propio para que editar y descartar apunten a
 * LA entrada y no al puesto que ocupa: el índice cambia cuando una de antes
 * se descarta, y un `PATCH` que viaja con un índice viejo editaría otra.
 */

/** El título con el que nace: lo dice ADR-0039 y lo busca la pantalla. */
export const TITULO_DE_LO_APRENDIDO = 'Lo que aprendí de tus chats de WhatsApp';

export type TipoDeEntrada = 'precio' | 'horario' | 'servicio' | 'despacho' | 'pago' | 'otro';

export interface EntradaAprendida {
  id: string;
  pregunta: string;
  respuesta: string;
  tipo: TipoDeEntrada;
  /** La del chat donde aparece la respuesta más reciente, si el modelo la trajo. */
  fecha?: string;
  /** Solo en las de precio: la marca para que la dueña la confirme (ADR-0039). */
  aviso?: string;
}

/** Lo que guarda la envoltura, tal como lo lee la pantalla de revisión. */
export interface LoAprendidoGuardado {
  tono: string | null;
  entradas: EntradaAprendida[];
}

const NO_ENCONTRADA = 'No encontramos esa fuente.';
export const NO_ESTA_POR_REVISAR =
  'Esa fuente no está por revisar: no hay nada que revisar en ella.';

function envolturaDe(content: string | null | undefined): LoAprendidoGuardado {
  let crudo: unknown = null;
  try {
    crudo = JSON.parse(content ?? '{}');
  } catch {
    crudo = null;
  }
  const objeto = (crudo && typeof crudo === 'object' ? crudo : {}) as {
    tono?: unknown;
    entradas?: unknown;
  };
  const tono = typeof objeto.tono === 'string' && objeto.tono.trim() ? objeto.tono : null;
  const entradas = Array.isArray(objeto.entradas)
    ? (objeto.entradas as EntradaAprendida[]).filter(
        (e) => e && typeof e.pregunta === 'string' && typeof e.respuesta === 'string',
      )
    : [];
  return { tono, entradas };
}

/** La fila con la fuente ya leída completa; exige que esté `por_revisar`. */
async function fuenteParaRevisar(
  client: PoolClient,
  tenantId: string,
  sourceId: string,
): Promise<{ source: Source; guardado: LoAprendidoGuardado }> {
  const r = await client.query('SELECT * FROM sources WHERE tenant_id = $1 AND id = $2', [
    tenantId,
    sourceId,
  ]);
  if (r.rowCount === 0) throw new Error(NO_ENCONTRADA);
  const source = rowToSource(r.rows[0]);
  if (source.status !== 'por_revisar') throw new Error(NO_ESTA_POR_REVISAR);
  return { source, guardado: envolturaDe(r.rows[0].content as string | null) };
}

/** Guarda la envoltura (la comparten editar, descartar y restaurar). */
async function guardar(
  client: PoolClient,
  tenantId: string,
  sourceId: string,
  guardado: LoAprendidoGuardado,
): Promise<void> {
  await client.query(
    'UPDATE sources SET content = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2',
    [tenantId, sourceId, JSON.stringify(guardado)],
  );
}

/**
 * Crea la fuente aprendida, ya `por_revisar`.
 *
 * La crea el job de workers cuando el proveedor devolvió entradas; por eso
 * no acepta una lista vacía: «sin entradas» no es una fuente que espera
 * revisión, es «no encontramos preguntas que se repitan», y el job lo marca
 * en la cuenta en vez de dejar una fuente muerta en la lista.
 *
 * Sin embeddings: se generan al APROBAR, cuando alguien ya miró lo que va
 * a quedar indexado. Hasta entonces lo aprendido es un borrador que la
 * búsqueda no ve.
 */
export async function crearFuenteAprendida(
  client: PoolClient,
  input: {
    tenantId: string;
    tono: string | null;
    entradas: Array<{
      pregunta: string;
      respuesta: string;
      tipo: TipoDeEntrada;
      fecha?: string;
      aviso?: string;
    }>;
    actor?: string;
    requestId?: string;
  },
): Promise<Source> {
  if (input.entradas.length === 0) {
    throw new Error('No hay entradas aprendidas: no se crea una fuente vacía.');
  }
  for (const e of input.entradas) {
    if (!e.pregunta?.trim() || !e.respuesta?.trim()) {
      throw new Error('Cada entrada aprendida necesita su pregunta y su respuesta.');
    }
  }
  const guardado: LoAprendidoGuardado = {
    tono: input.tono ? input.tono.slice(0, 400) : null,
    entradas: input.entradas.slice(0, 30).map((e, i) => ({
      id: `e${i + 1}`,
      pregunta: e.pregunta.trim(),
      respuesta: e.respuesta.trim(),
      tipo: e.tipo,
      ...(e.fecha ? { fecha: e.fecha } : {}),
      ...(e.aviso ? { aviso: e.aviso } : {}),
    })),
  };
  const r = await client.query(
    `INSERT INTO sources (tenant_id, kind, name, content, status)
     VALUES ($1, 'faq', $2, $3, 'por_revisar') RETURNING *`,
    [input.tenantId, TITULO_DE_LO_APRENDIDO, JSON.stringify(guardado)],
  );
  const source = rowToSource(r.rows[0]);
  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: input.actor ?? 'system',
    actorKind: 'system',
    action: 'knowledge.source.aprendido',
    resource: 'source',
    resourceId: source.id,
    result: 'ok',
    metadata: { entradas: guardado.entradas.length, conTono: guardado.tono !== null },
    ...(input.requestId ? { requestId: input.requestId } : {}),
  });
  // El mismo evento que cualquier fuente nueva: la puesta en marcha cuenta
  // «cargaste conocimiento» con esto, que es cierto — aunque falte revisarlo.
  await publishEvent(client, {
    name: 'knowledge.source_added',
    tenantId: input.tenantId,
    payload: { sourceId: source.id, kind: 'faq', porRevisar: true },
    actor: input.actor ?? 'system',
    ...(input.requestId ? { requestId: input.requestId } : {}),
  });
  return source;
}

/** La fuente aprendida con sus entradas, para la pantalla de revisión. */
export async function leerFuenteAprendida(
  client: PoolClient,
  input: { tenantId: string; sourceId: string },
): Promise<LoAprendidoGuardado & { source: Source }> {
  const { source, guardado } = await fuenteParaRevisar(client, input.tenantId, input.sourceId);
  return { source, ...guardado };
}

/** Edita una entrada: la respuesta y/o el tipo, mientras la dueña revisa. */
export async function editarEntradaAprendida(
  client: PoolClient,
  input: {
    tenantId: string;
    sourceId: string;
    entradaId: string;
    respuesta?: string;
    tipo?: TipoDeEntrada;
    actor: string;
    requestId?: string;
  },
): Promise<LoAprendidoGuardado> {
  const { guardado } = await fuenteParaRevisar(client, input.tenantId, input.sourceId);
  const entrada = guardado.entradas.find((e) => e.id === input.entradaId);
  if (!entrada) throw new Error('No encontramos esa entrada.');
  if (input.respuesta !== undefined) {
    if (!input.respuesta.trim()) throw new Error('La entrada necesita su respuesta.');
    entrada.respuesta = input.respuesta.trim();
  }
  if (input.tipo !== undefined) entrada.tipo = input.tipo;
  await guardar(client, input.tenantId, input.sourceId, guardado);
  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: input.actor,
    actorKind: 'user',
    action: 'knowledge.source.entrada.editada',
    resource: 'source',
    resourceId: input.sourceId,
    result: 'ok',
    // El tipo sí viaja: cambia cómo la IA trata la entrada. La respuesta no:
    // es contenido del negocio, no un dato de la auditoría, y duplicarla acá
    // sería una segunda copia de lo mismo.
    metadata: { entrada: input.entradaId, tipo: entrada.tipo },
    ...(input.requestId ? { requestId: input.requestId } : {}),
  });
  return guardado;
}

/**
 * Descarta UNA entrada: se saca de la fuente y no entra a la base del
 * conocimiento cuando se apruebe.
 *
 * La fuente entera se borra por el camino de siempre (`eliminarFuente`,
 * SPEC §39); descartar la última entrada deja la fuente vacía a propósito,
 * con su fila visible, para que el borrado siga siendo una decisión con
 * botón propio y no un efecto secundario de tachar la última línea.
 */
export async function descartarEntradaAprendida(
  client: PoolClient,
  input: { tenantId: string; sourceId: string; entradaId: string; actor: string; requestId?: string },
): Promise<LoAprendidoGuardado> {
  const { guardado } = await fuenteParaRevisar(client, input.tenantId, input.sourceId);
  const antes = guardado.entradas.length;
  guardado.entradas = guardado.entradas.filter((e) => e.id !== input.entradaId);
  if (guardado.entradas.length === antes) throw new Error('No encontramos esa entrada.');
  await guardar(client, input.tenantId, input.sourceId, guardado);
  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: input.actor,
    actorKind: 'user',
    action: 'knowledge.source.entrada.descartada',
    resource: 'source',
    resourceId: input.sourceId,
    result: 'ok',
    metadata: { entrada: input.entradaId, quedan: guardado.entradas.length },
    ...(input.requestId ? { requestId: input.requestId } : {}),
  });
  return guardado;
}

/**
 * Aprueba: la fuente pasa por el camino normal — embeddings y `active`.
 *
 * El contenido se abre a la forma `faq` de siempre (`[{q, a}]`) y corre
 * `processSource`, que trocea, embebe y deja `active`. La dueña ya miró cada
 * entrada, así que el precio aprendido ya no necesita su aviso: el aviso era
 * para ANTES de aprobar.
 *
 * Si la indexación falla —`processSource` atrapa a su proveedor y devuelve
 * la fuente `failed` con el motivo; lo demás sube como excepción— la
 * envoltura se restaura: la fuente sigue revisable y el arreglo es el mismo
 * botón «Reindexar» de siempre, en vez de dejar un JSON a medio abrir que
 * ninguna pantalla sabe leer.
 */
export async function aprobarFuenteAprendida(
  client: PoolClient,
  input: { tenantId: string; sourceId: string; actor: string; requestId?: string },
  ports: ProcessPorts = {},
): Promise<Source> {
  const { guardado } = await fuenteParaRevisar(client, input.tenantId, input.sourceId);
  if (guardado.entradas.length === 0) {
    throw new Error('No quedan entradas en esta fuente: bórrala si no quieres mantenerla.');
  }
  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: input.actor,
    actorKind: 'user',
    action: 'knowledge.source.aprobada',
    resource: 'source',
    resourceId: input.sourceId,
    result: 'ok',
    metadata: { entradas: guardado.entradas.length },
    ...(input.requestId ? { requestId: input.requestId } : {}),
  });
  await client.query(
    'UPDATE sources SET content = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2',
    [
      input.tenantId,
      input.sourceId,
      JSON.stringify(guardado.entradas.map((e) => ({ q: e.pregunta, a: e.respuesta }))),
    ],
  );
  const restaurar = () => guardar(client, input.tenantId, input.sourceId, guardado);
  try {
    const resultado = await processSource(client, { ...input }, ports);
    if (resultado.status !== 'active') await restaurar();
    return resultado;
  } catch (err) {
    await restaurar();
    throw err;
  }
}
