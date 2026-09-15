import type { PoolClient } from 'pg';
import { getPipelineStages } from './deals';

/**
 * Editar el pipeline (SPEC §23, issue 248).
 *
 * Los pipelines se creaban con el configurador (#50) y de ahí quedaban
 * congelados: `crm.pipelines.manage` estaba anotado como pendiente y no
 * había forma de renombrar una etapa, reordenarlas ni agregar una. Un
 * negocio que cambia su forma de vender tenía que aguantar la que eligió el
 * primer día.
 *
 * La regla de fondo: **editar la forma del embudo nunca puede perder una
 * oportunidad**. Por eso borrar una etapa con oportunidades adentro se
 * rechaza y se dice cuántas hay; moverlas es una decisión del negocio, no
 * nuestra.
 */

export interface EtapaEditada {
  id: string;
  name: string;
  position: number;
  type: 'open' | 'won' | 'lost';
  probability: number | null;
  expectedDays: number | null;
}

function nombreLimpio(nombre: string): string {
  const limpio = (nombre ?? '').trim().replace(/\s+/g, ' ');
  if (!limpio) throw new Error('La etapa necesita un nombre.');
  if (limpio.length > 40) throw new Error('El nombre de la etapa es muy largo (máximo 40).');
  return limpio;
}

export async function renamePipeline(
  client: PoolClient,
  input: { tenantId: string; pipelineId: string; name: string },
): Promise<{ id: string; name: string }> {
  const name = nombreLimpio(input.name);
  const r = await client.query(
    'UPDATE pipelines SET name = $3 WHERE tenant_id = $1 AND id = $2 RETURNING id, name',
    [input.tenantId, input.pipelineId, name],
  );
  if (r.rowCount === 0) throw new Error('Ese pipeline no existe en este negocio.');
  return r.rows[0];
}

export async function updateStage(
  client: PoolClient,
  input: {
    tenantId: string;
    stageId: string;
    name?: string;
    probability?: number | null;
    expectedDays?: number | null;
  },
): Promise<EtapaEditada> {
  const campos: string[] = [];
  const valores: unknown[] = [input.tenantId, input.stageId];
  if (input.name !== undefined) {
    valores.push(nombreLimpio(input.name));
    campos.push(`name = $${valores.length}`);
  }
  if (input.probability !== undefined) {
    if (input.probability !== null && (input.probability < 0 || input.probability > 100)) {
      throw new Error('La probabilidad va de 0 a 100.');
    }
    valores.push(input.probability);
    campos.push(`probability = $${valores.length}`);
  }
  if (input.expectedDays !== undefined) {
    if (input.expectedDays !== null && input.expectedDays < 0) {
      throw new Error('Los días esperados no pueden ser negativos.');
    }
    valores.push(input.expectedDays);
    campos.push(`expected_days = $${valores.length}`);
  }
  if (campos.length === 0) throw new Error('No hay nada que cambiar en la etapa.');

  // El TIPO no se toca: una etapa 'won' que pase a 'open' dejaría negocios
  // ganados colgando en un limbo, y los números del tablero mentirían hacia
  // atrás. Para eso se crea otra etapa y se mueven las oportunidades.
  const r = await client.query(
    `UPDATE stages SET ${campos.join(', ')} WHERE tenant_id = $1 AND id = $2
     RETURNING id, name, position, type, probability, expected_days`,
    valores,
  );
  if (r.rowCount === 0) throw new Error('Esa etapa no existe en este negocio.');
  const fila = r.rows[0];
  return {
    id: fila.id,
    name: fila.name,
    position: fila.position,
    type: fila.type,
    probability: fila.probability,
    expectedDays: fila.expected_days,
  };
}

/**
 * Agrega una etapa ANTES de la de cierre: nadie quiere una etapa nueva
 * después de "Ganado". Si el negocio la quiere en otro lugar, la reordena.
 */
export async function addStage(
  client: PoolClient,
  input: { tenantId: string; pipelineId: string; name: string; expectedDays?: number },
): Promise<EtapaEditada> {
  const name = nombreLimpio(input.name);
  const etapas = await getPipelineStages(client, input.tenantId, input.pipelineId);
  if (etapas.length === 0) throw new Error('Ese pipeline no existe en este negocio.');

  const primeraDeCierre = etapas.find((e) => e.type !== 'open');
  const posicion = primeraDeCierre ? primeraDeCierre.position : etapas.length;

  // Hueco para la nueva. En DOS pasos y no en uno: el índice único
  // (pipeline, position) se evalúa fila por fila, así que un
  // `position = position + 1` choca con la fila de al lado a mitad de
  // camino. Primero se van todas lejos, después vuelven a su lugar.
  await client.query(
    `UPDATE stages SET position = position + 1000
      WHERE tenant_id = $1 AND pipeline_id = $2 AND position >= $3`,
    [input.tenantId, input.pipelineId, posicion],
  );
  await client.query(
    `UPDATE stages SET position = position - 999
      WHERE tenant_id = $1 AND pipeline_id = $2 AND position >= 1000`,
    [input.tenantId, input.pipelineId],
  );
  const r = await client.query(
    `INSERT INTO stages (tenant_id, pipeline_id, name, position, type, expected_days)
     VALUES ($1, $2, $3, $4, 'open', $5)
     RETURNING id, name, position, type, probability, expected_days`,
    [input.tenantId, input.pipelineId, name, posicion, input.expectedDays ?? null],
  );
  const fila = r.rows[0];
  return {
    id: fila.id,
    name: fila.name,
    position: fila.position,
    type: fila.type,
    probability: fila.probability,
    expectedDays: fila.expected_days,
  };
}

/**
 * Reordena las etapas abiertas. Las de cierre ('won' y 'lost') se quedan al
 * final: mover "Perdido" al medio del embudo no significa nada.
 */
export async function reorderStages(
  client: PoolClient,
  input: { tenantId: string; pipelineId: string; stageIds: string[] },
): Promise<EtapaEditada[]> {
  const etapas = await getPipelineStages(client, input.tenantId, input.pipelineId);
  if (etapas.length === 0) throw new Error('Ese pipeline no existe en este negocio.');

  const abiertas = etapas.filter((e) => e.type === 'open');
  const pedidas = [...new Set(input.stageIds)];
  const sonLasMismas =
    pedidas.length === abiertas.length && pedidas.every((id) => abiertas.some((e) => e.id === id));
  if (!sonLasMismas) {
    throw new Error('Para reordenar hay que mandar todas las etapas abiertas, y solo esas.');
  }

  // Posiciones temporales altas primero: el índice único (pipeline,
  // position) no deja dos etapas en el mismo lugar ni por un instante.
  await client.query(
    `UPDATE stages SET position = position + 1000 WHERE tenant_id = $1 AND pipeline_id = $2`,
    [input.tenantId, input.pipelineId],
  );
  for (let i = 0; i < pedidas.length; i++) {
    await client.query('UPDATE stages SET position = $3 WHERE tenant_id = $1 AND id = $2', [
      input.tenantId,
      pedidas[i],
      i,
    ]);
  }
  const cierre = etapas.filter((e) => e.type !== 'open');
  for (let i = 0; i < cierre.length; i++) {
    await client.query('UPDATE stages SET position = $3 WHERE tenant_id = $1 AND id = $2', [
      input.tenantId,
      cierre[i].id,
      pedidas.length + i,
    ]);
  }
  const final = await getPipelineStages(client, input.tenantId, input.pipelineId);
  return final.map((e) => ({
    id: e.id,
    name: e.name,
    position: e.position,
    type: e.type as 'open' | 'won' | 'lost',
    probability: (e as { probability?: number | null }).probability ?? null,
    expectedDays: (e as { expectedDays?: number | null }).expectedDays ?? null,
  }));
}

/**
 * Borra una etapa VACÍA. Con oportunidades adentro se rechaza y se dice
 * cuántas hay: moverlas es una decisión del negocio —¿se ganaron?, ¿se
 * perdieron?, ¿siguen abiertas en otra etapa?— y nosotros no la podemos
 * tomar por él sin mentirle a sus números.
 */
export async function deleteStage(
  client: PoolClient,
  input: { tenantId: string; stageId: string },
): Promise<void> {
  const etapa = await client.query(
    'SELECT pipeline_id, type, position FROM stages WHERE tenant_id = $1 AND id = $2',
    [input.tenantId, input.stageId],
  );
  if (etapa.rowCount === 0) throw new Error('Esa etapa no existe en este negocio.');
  if (etapa.rows[0].type !== 'open') {
    throw new Error('Las etapas de cierre (ganado y perdido) no se borran: el embudo las necesita.');
  }

  const conDeals = await client.query(
    'SELECT count(*)::int AS n FROM deals WHERE tenant_id = $1 AND stage_id = $2',
    [input.tenantId, input.stageId],
  );
  const n = conDeals.rows[0].n as number;
  if (n > 0) {
    throw new Error(
      `Esa etapa tiene ${n} oportunidad${n === 1 ? '' : 'es'}. Muévelas antes de borrarla.`,
    );
  }

  const abiertas = await client.query(
    `SELECT count(*)::int AS n FROM stages
      WHERE tenant_id = $1 AND pipeline_id = $2 AND type = 'open'`,
    [input.tenantId, etapa.rows[0].pipeline_id],
  );
  if ((abiertas.rows[0].n as number) <= 1) {
    throw new Error('Un embudo sin etapas abiertas no sirve para nada: deja al menos una.');
  }

  await client.query('DELETE FROM stages WHERE tenant_id = $1 AND id = $2', [
    input.tenantId,
    input.stageId,
  ]);
  // El hueco se cierra: las posiciones son consecutivas y el tablero las usa
  // para ordenar las columnas.
  await client.query(
    `UPDATE stages SET position = position + 1000
      WHERE tenant_id = $1 AND pipeline_id = $2 AND position > $3`,
    [input.tenantId, etapa.rows[0].pipeline_id, etapa.rows[0].position],
  );
  await client.query(
    `UPDATE stages SET position = position - 1001
      WHERE tenant_id = $1 AND pipeline_id = $2 AND position >= 1000`,
    [input.tenantId, etapa.rows[0].pipeline_id],
  );
}
