import type { Pool, PoolClient } from 'pg';
import { withTenant } from '@iaxti/db';
import type { AlmacenObjetos } from '@iaxti/core';
import { writeAudit } from '@iaxti/module-audit';

/**
 * La ventana invisible (#751).
 *
 * `deleteSource` borra el archivo de R2 DENTRO de la transacción y confirma
 * después. Si el commit falla, `eliminarFuente` marca la fuente
 * `delete_failed` desde afuera (#631) y el usuario se entera. Pero si el
 * PROCESO MUERE en el medio —OOM, deploy, el contenedor que se va— no hay
 * nadie afuera: la fila vuelve viva por el rollback, sin archivo, y el
 * conocimiento la sigue citando. Un PDF que nadie puede abrir, citado como si
 * existiera, es peor que una fuente faltante: nadie sale a buscarlo.
 *
 * El arreglo es anotar la INTENCIÓN antes de tocar el bucket, en su propia
 * transacción, y que un barrido reconcilie lo que quedó colgando. Dos reglas
 * sostienen que esto sea seguro:
 *
 * 1. **El barrido no borra archivos.** Nunca. Solo mira y anota. Un barrido
 *    que borrara, con una condición mal escrita o una fila vieja que quedó,
 *    destruiría documentos que nadie pidió borrar y eso no se deshace. Hay una
 *    prueba que lo fija.
 * 2. **Decide la realidad, no la intención.** Que exista la anotación no
 *    significa que el archivo se haya borrado: puede no haberse alcanzado a
 *    tocar. Por eso el barrido PREGUNTA —al bucket si el archivo está, a la
 *    base si la fuente sigue viva— y recién entonces decide.
 */

/**
 * El candado del ARCHIVO, tomado por el borrado y por el barrido (#971).
 *
 * Sin esto hay una carrera que la ventana de antigüedad no cierra del todo:
 * mientras la transacción que borra está en vuelo, el archivo ya no está en
 * el bucket pero la fila de `sources` todavía se ve viva —su DELETE no
 * confirmó—. El barrido cruza esas dos respuestas y concluye lo que no es:
 * «fuente viva, archivo destruido».
 *
 * El daño no es la marca —el `UPDATE` se queda esperando el candado de esa
 * fila y al confirmar el borrado no afecta ninguna— sino lo que queda
 * ESCRITO: una entrada en el libro diciendo que una fuente perdió su archivo,
 * sobre un borrado que salió perfecto. Una auditoría que miente es peor que
 * una que falta.
 *
 * Diez minutos de antigüedad hacen la carrera improbable, no imposible: un
 * borrado lento —un bucket que tarda, un commit detrás de un pooler cargado—
 * cae dentro. El candado la vuelve imposible, que es distinto.
 *
 * Es `xact`: se suelta solo al terminar la transacción, con COMMIT o con
 * ROLLBACK. No hay nada que recordar soltar, y un proceso que muere no deja
 * un candado puesto — que es precisamente el caso que todo esto viene a
 * resolver.
 */
export async function bloquearArchivo(
  client: PoolClient,
  input: { tenantId: string; r2Key: string; intentar?: boolean },
): Promise<boolean> {
  // El tenant va DENTRO de la llave: dos negocios con el mismo nombre de
  // archivo no son el mismo archivo, y compartir candado los haría esperarse
  // entre ellos sin motivo.
  const llave = `${input.tenantId}:${input.r2Key}`;
  if (input.intentar) {
    const r = await client.query<{ libre: boolean }>(
      'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 751)) AS libre',
      [llave],
    );
    return r.rows[0].libre;
  }
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 751))', [llave]);
  return true;
}

/**
 * Vive acá y no en `sources.ts` (#751) porque sus dos usos son este arreglo:
 * el que marca desde afuera cuando el commit falló (#631) y el barrido que
 * marca lo que quedó colgando. Tenerla acá deja la flecha en un solo sentido
 * —`sources` usa esto, esto no usa `sources`— en vez de un ciclo entre los
 * dos archivos.
 */
/**
 * Marca una fuente como «su archivo ya no está» (#631).
 *
 * Recibe el POOL y no un cliente, a propósito: se llama justo después de que una
 * transacción se deshizo, y ese cliente ya no sirve para escribir nada. La marca
 * tiene que viajar por una conexión aparte o no viaja.
 *
 * No limpia `knowledge_query_cache`: el chequeo de frescura (#621) ya pide
 * `FUENTE_VIGENTE` sobre cada fuente citada, y `delete_failed` no la cumple. Un
 * `DELETE` más acá sería un segundo lugar donde se decide lo mismo.
 */
export async function marcarFuenteSinArchivo(
  pool: Pool,
  input: { tenantId: string; sourceId: string },
): Promise<boolean> {
  return withTenant(pool, input.tenantId, async (client) => {
    const marcada = await client.query(
      `UPDATE sources
          SET status = 'delete_failed',
              error = 'Se eliminó el archivo guardado y la eliminación de la fuente no llegó a completarse. Vuelve a subir el documento o termina de borrar la fuente.',
              updated_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [input.tenantId, input.sourceId],
    );
    // Si no marcó nada, la fuente ya no está: el borrado terminó bien mientras
    // esta marca esperaba su turno en el candado de la fila. Escribir igual en
    // el libro dejaría dicho que una fuente perdió su archivo cuando lo que
    // pasó fue un borrado limpio (#971).
    if (marcada.rowCount === 0) return false;
    await writeAudit(client, {
      tenantId: input.tenantId,
      actor: 'system',
      actorKind: 'system',
      action: 'knowledge.source.sin_archivo',
      resource: 'source',
      resourceId: input.sourceId,
      result: 'ok',
      metadata: { motivo: 'el archivo se borró y la transacción no confirmó' },
    });
    return true;
  });
}


/** Cuánto esperar antes de mirar una anotación. */
const ANTIGUEDAD_MINUTOS = 10;

/**
 * Deja escrito que se va a borrar este archivo, ANTES de tocarlo.
 *
 * En su propia transacción y por su propia conexión: la transacción que borra
 * la fuente tiene el candado de esa fila y va a hacer ROLLBACK si algo sale
 * mal, que es justo el caso que hay que poder ver después. Si esta anotación
 * viajara con ella, desaparecería con ella.
 *
 * Devuelve el id de la anotación, o `null` si no se pudo anotar. `null` no
 * aborta el borrado: la anotación es una red, no un permiso, y negarse a
 * borrar porque no se pudo escribir la red dejaría al usuario sin poder
 * eliminar su documento por un problema que no es suyo.
 */
export async function anotarBorradoPendiente(
  pool: Pool,
  input: { tenantId: string; sourceId: string; r2Key: string },
): Promise<string | null> {
  try {
    let id: string | null = null;
    await withTenant(pool, input.tenantId, async (client) => {
      const r = await client.query(
        `INSERT INTO pending_file_deletions (tenant_id, source_id, r2_key)
         VALUES ($1, $2, $3) RETURNING id`,
        [input.tenantId, input.sourceId, input.r2Key],
      );
      id = String(r.rows[0].id);
    });
    return id;
  } catch {
    return null;
  }
}

/**
 * El borrado terminó bien: la anotación ya no tiene nada que vigilar.
 *
 * Se marca en vez de borrarse la fila para que quede el rastro de que hubo un
 * borrado de archivo y cuándo, que es lo que uno quiere tener el día que
 * alguien pregunte por un documento que no está.
 */
export async function confirmarBorradoPendiente(
  pool: Pool,
  input: { tenantId: string; id: string },
): Promise<void> {
  try {
    await withTenant(pool, input.tenantId, async (client) => {
      await client.query(
        `UPDATE pending_file_deletions SET confirmed_at = now()
          WHERE tenant_id = $1 AND id = $2 AND confirmed_at IS NULL`,
        [input.tenantId, input.id],
      );
    });
  } catch {
    // Que no se pueda confirmar no es grave y NO debe romper un borrado que
    // ya salió bien: la anotación queda colgando y el barrido la resuelve
    // mirando la realidad, que es exactamente para lo que está.
  }
}

export interface ResultadoDelBarrido {
  /** Anotaciones lo bastante viejas como para mirarlas. */
  revisadas: number;
  /** Fuentes marcadas `delete_failed`: el archivo no está y la fuente sí. */
  marcadas: number;
  /** Anotaciones cerradas sin novedad: el borrado había salido bien. */
  cerradas: number;
  /** El bucket no contestó: quedan para la próxima corrida. */
  sinDecidir: number;
  /**
   * Había un borrado EN VUELO sobre ese archivo: no se mira, no se decide
   * (#971). La próxima corrida la encuentra ya resuelta en un sentido o en el
   * otro.
   */
  enVuelo: number;
}

/**
 * Reconcilia los borrados que quedaron a medias. NO BORRA ARCHIVOS.
 *
 * Corre por tenant desde la cola scheduled, como `expireSources`.
 *
 * Mira solo anotaciones de más de `ANTIGUEDAD_MINUTOS`: un borrado en curso
 * tiene su anotación sin confirmar durante los segundos que dura, y mirarlo
 * ahí sería correr contra él.
 *
 * Para cada una pregunta dos cosas y cruza las respuestas:
 *
 * - **La fuente ya no está** → el borrado llegó a confirmar; solo faltó cerrar
 *   la anotación. Se cierra.
 * - **La fuente está y el archivo también** → no se alcanzó a tocar el bucket.
 *   No pasó nada. Se cierra.
 * - **La fuente está y el archivo NO** → esta es la ventana: fuente viva,
 *   archivo destruido. Se marca `delete_failed` (#631) y el conocimiento deja
 *   de citarla.
 * - **El bucket no contestó** → se deja para después. Tratar un 500 como
 *   ausencia marcaría fuentes sanas cada vez que R2 tenga un mal minuto.
 */
export async function reconciliarBorradosPendientes(
  pool: Pool,
  tenantId: string,
  opciones: { almacen: AlmacenObjetos | null; antiguedadMinutos?: number },
): Promise<ResultadoDelBarrido> {
  const vacio: ResultadoDelBarrido = { revisadas: 0, marcadas: 0, cerradas: 0, sinDecidir: 0, enVuelo: 0 };
  // Sin almacén no hay a quién preguntarle si el archivo está, y sin esa
  // respuesta no hay decisión que tomar. Salir sin hacer nada es lo correcto:
  // las anotaciones quedan para un ambiente que sí pueda mirarlas.
  if (!opciones.almacen) return vacio;
  const almacen = opciones.almacen;
  const minutos = opciones.antiguedadMinutos ?? ANTIGUEDAD_MINUTOS;

  // La lectura cierra su transacción antes de salir a la red: el HEAD a R2
  // puede tardar, y una transacción abierta esperando a un tercero es cómo se
  // acaban las conexiones del pool.
  let pendientes: Array<{ id: string; sourceId: string; r2Key: string; viva: boolean }> = [];
  await withTenant(pool, tenantId, async (client) => {
    const r = await client.query(
      `SELECT p.id, p.source_id, p.r2_key, (s.id IS NOT NULL) AS viva
         FROM pending_file_deletions p
         LEFT JOIN sources s ON s.tenant_id = p.tenant_id AND s.id = p.source_id
        WHERE p.tenant_id = $1
          AND p.confirmed_at IS NULL
          AND p.created_at < now() - ($2 || ' minutes')::interval
        ORDER BY p.created_at
        LIMIT 200`,
      [tenantId, String(minutos)],
    );
    pendientes = r.rows.map((row) => ({
      id: String(row.id),
      sourceId: String(row.source_id),
      r2Key: String(row.r2_key),
      viva: Boolean(row.viva),
    }));
  });

  const resultado: ResultadoDelBarrido = { ...vacio, revisadas: pendientes.length };
  for (const p of pendientes) {
    if (!p.viva) {
      // La fuente se fue: el borrado completó. Nada que reparar.
      await cerrar(pool, tenantId, p.id, 'la fuente ya no existe');
      resultado.cerradas += 1;
      continue;
    }
    // La fuente sigue viva: o el bucket no se tocó, o se tocó y el commit no
    // llegó... o hay un borrado EN VUELO justo ahora, que se vería igual que
    // la ventana rota: el archivo ya no está y la fila todavía no desapareció
    // porque su DELETE no confirmó.
    //
    // El candado distingue los dos casos sin esperar a nadie: si está tomado,
    // hay alguien borrando y acá no hay nada que decidir (#971).
    const libre = await withTenant(pool, tenantId, (client) =>
      bloquearArchivo(client, { tenantId, r2Key: p.r2Key, intentar: true }),
    );
    if (!libre) {
      resultado.enVuelo += 1;
      continue;
    }
    const esta = await almacen.existe(p.r2Key);
    if (esta === null) {
      resultado.sinDecidir += 1;
      continue;
    }
    if (esta) {
      await cerrar(pool, tenantId, p.id, 'el archivo sigue en el almacenamiento');
      resultado.cerradas += 1;
      continue;
    }
    // Fuente viva, archivo destruido: la ventana que este barrido existe para
    // cerrar. La marca es la misma de #631 para que el conocimiento y la
    // pantalla no tengan que aprender un estado nuevo.
    const marcada = await marcarFuenteSinArchivo(pool, { tenantId, sourceId: p.sourceId });
    if (!marcada) {
      // La fuente se fue entre la lectura y la marca: el borrado completó. No
      // hay nada que reparar y, sobre todo, nada que anotar como reparado.
      await cerrar(pool, tenantId, p.id, 'la fuente ya no existe');
      resultado.cerradas += 1;
      continue;
    }
    await cerrar(pool, tenantId, p.id, 'la fuente quedó sin su archivo y se marcó');
    resultado.marcadas += 1;
  }
  return resultado;
}

/** Cierra la anotación dejando dicho por qué. */
async function cerrar(pool: Pool, tenantId: string, id: string, motivo: string): Promise<void> {
  await withTenant(pool, tenantId, async (client) => {
    const r = await client.query(
      `UPDATE pending_file_deletions SET confirmed_at = now()
        WHERE tenant_id = $1 AND id = $2 AND confirmed_at IS NULL
        RETURNING source_id`,
      [tenantId, id],
    );
    if (r.rowCount === 0) return;
    await writeAudit(client, {
      tenantId,
      actor: 'system',
      actorKind: 'system',
      action: 'knowledge.borrado_pendiente.reconciliado',
      resource: 'source',
      resourceId: String(r.rows[0].source_id),
      result: 'ok',
      metadata: { motivo },
    });
  });
}
