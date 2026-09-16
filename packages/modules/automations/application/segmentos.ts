import type { PoolClient } from 'pg';

/**
 * Segmentos de la cartera (#75, SPEC §15).
 *
 * "Mándale la promo a todos los que cotizaron y no compraron" es lo que
 * pide un negocio con cartera. Traducido: contactos con tal etiqueta, en
 * tal etapa, sin actividad hace tantos días.
 *
 * Todo lo que sale de acá es para MIRAR antes de mandar: el conteo exacto y
 * una muestra. Nadie debería apretar "enviar" sin haber visto a quién.
 */

export interface FiltrosSegmento {
  /** Ids de etiquetas: el contacto tiene TODAS. */
  tagIds?: string[];
  /** Ids de etapa del embudo: tiene una oportunidad en alguna de ellas. */
  stageIds?: string[];
  /** Sin actividad hace al menos N días. */
  sinActividadDias?: number;
  /** Un campo personalizado con este valor exacto. */
  campo?: { key: string; valor: string };
  /** Origen del contacto (whatsapp, instagram, webchat…). */
  origen?: string;
}

export interface ContactoDelSegmento {
  id: string;
  name: string | null;
  phone: string | null;
  lastActivityAt: Date | null;
}

/**
 * Arma el WHERE del segmento. Devuelve las condiciones y sus parámetros
 * para que el conteo y la muestra usen EXACTAMENTE la misma consulta: si se
 * escribieran por separado, el número de la vista previa y el de la campaña
 * podrían no coincidir, y ahí la vista previa deja de servir.
 */
function condiciones(
  tenantId: string,
  filtros: FiltrosSegmento,
): { where: string; params: unknown[] } {
  const where: string[] = ['c.tenant_id = $1', 'c.merged_into IS NULL'];
  const params: unknown[] = [tenantId];

  // Sin consentimiento no entra NI a la vista previa: que aparezca en el
  // conteo de una campaña que nunca lo va a incluir es mentirle al negocio.
  where.push("c.opted_out_at IS NULL");
  where.push("(c.opt_in_at IS NOT NULL OR c.origin IN ('whatsapp','webchat','instagram','messenger'))");
  where.push('c.phone IS NOT NULL');

  if (filtros.tagIds?.length) {
    params.push(filtros.tagIds);
    where.push(`(
      SELECT count(DISTINCT ct.tag_id) FROM contact_tags ct
       WHERE ct.tenant_id = c.tenant_id AND ct.contact_id = c.id
         AND ct.tag_id = ANY($${params.length}::uuid[])
    ) = ${filtros.tagIds.length}`);
  }
  if (filtros.stageIds?.length) {
    params.push(filtros.stageIds);
    where.push(`EXISTS (
      SELECT 1 FROM deals d
       WHERE d.tenant_id = c.tenant_id AND d.contact_id = c.id
         AND d.stage_id = ANY($${params.length}::uuid[])
    )`);
  }
  if (filtros.sinActividadDias !== undefined) {
    params.push(Math.max(0, Math.floor(Number(filtros.sinActividadDias) || 0)));
    where.push(
      `(c.last_activity_at IS NULL OR c.last_activity_at < now() - make_interval(days => $${params.length}))`,
    );
  }
  if (filtros.campo?.key) {
    params.push(filtros.campo.key);
    const k = params.length;
    params.push(String(filtros.campo.valor ?? ''));
    where.push(`c.custom ->> $${k} = $${params.length}`);
  }
  if (filtros.origen) {
    params.push(filtros.origen);
    where.push(`c.origin = $${params.length}`);
  }

  return { where: where.join(' AND '), params };
}

/**
 * Cuántos son y quiénes se ven. `muestra` existe para que una persona pueda
 * reconocer a alguien y decir "espera, a este no": un número solo no deja
 * darse cuenta de nada.
 */
export async function previsualizarSegmento(
  client: PoolClient,
  input: { tenantId: string; filtros: FiltrosSegmento; muestra?: number },
): Promise<{ total: number; muestra: ContactoDelSegmento[] }> {
  const { where, params } = condiciones(input.tenantId, input.filtros);
  const cuantos = await client.query(
    `SELECT count(*)::int AS n FROM contacts c WHERE ${where}`,
    params,
  );
  const limite = Math.min(Math.max(1, input.muestra ?? 10), 50);
  const filas = await client.query(
    `SELECT c.id, c.name, c.phone, c.last_activity_at
       FROM contacts c WHERE ${where}
      ORDER BY c.last_activity_at DESC NULLS LAST
      LIMIT ${limite}`,
    params,
  );
  return {
    total: cuantos.rows[0].n as number,
    muestra: filas.rows.map((r) => ({
      id: r.id as string,
      name: (r.name as string) ?? null,
      phone: (r.phone as string) ?? null,
      lastActivityAt: (r.last_activity_at as Date) ?? null,
    })),
  };
}

/** Los ids, para el envío. Con tope duro: una campaña no es un barrido. */
export async function contactosDelSegmento(
  client: PoolClient,
  input: { tenantId: string; filtros: FiltrosSegmento; tope?: number },
): Promise<string[]> {
  const { where, params } = condiciones(input.tenantId, input.filtros);
  const tope = Math.min(Math.max(1, Math.floor(Number(input.tope) || 5000)), 5000);
  const r = await client.query(
    `SELECT c.id FROM contacts c WHERE ${where} ORDER BY c.created_at LIMIT ${tope}`,
    params,
  );
  return r.rows.map((x) => x.id as string);
}

export async function guardarSegmento(
  client: PoolClient,
  input: { tenantId: string; name: string; filtros: FiltrosSegmento; actor?: string },
): Promise<{ id: string; name: string }> {
  const name = (input.name ?? '').trim();
  if (!name) throw new Error('El segmento necesita un nombre.');
  const r = await client.query(
    `INSERT INTO segments (tenant_id, name, filters, created_by)
     VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (tenant_id, name) DO UPDATE SET filters = EXCLUDED.filters, updated_at = now()
     RETURNING id, name`,
    [input.tenantId, name, JSON.stringify(input.filtros ?? {}), input.actor ?? null],
  );
  return r.rows[0];
}

export async function listarSegmentos(
  client: PoolClient,
  tenantId: string,
): Promise<Array<{ id: string; name: string; filters: FiltrosSegmento }>> {
  const r = await client.query(
    'SELECT id, name, filters FROM segments WHERE tenant_id = $1 ORDER BY name',
    [tenantId],
  );
  return r.rows.map((x) => ({ id: x.id, name: x.name, filters: x.filters }));
}
