import type { PoolClient } from 'pg';
import { publishEvent } from '@iaxti/core';
import { contactosDelSegmento, previsualizarSegmento, type FiltrosSegmento } from './segmentos';

/**
 * Campañas: una plantilla aprobada a un segmento de la cartera (#75).
 *
 * Es la función que más rápido puede arruinarle la reputación a un negocio.
 * Tres decisiones cargan con eso:
 *
 *  1. **Vista previa obligatoria antes de mandar.** El conteo y la muestra
 *     salen de la MISMA consulta que después elige a quién se le manda: si
 *     fueran dos consultas distintas, la vista previa dejaría de significar
 *     algo.
 *  2. **Una fila por destinatario, con el motivo si no se le mandó.** Un
 *     "enviados: 120 de 200" sin decir qué pasó con los 80 obliga a
 *     adivinar, y lo que se adivina es siempre lo más cómodo.
 *  3. **La calidad del número manda.** En rojo no sale la campaña: mandarle
 *     promoción a mil personas desde un número que Meta ya está mirando es
 *     la forma más corta de perderlo.
 *
 * Lo que NO se decide acá, porque ya está decidido en la cola: el horario
 * de silencio, la pausa por calidad del envío individual y el estado del
 * tenant. La campaña marca cada mensaje como iniciado por el negocio y la
 * cola hace el resto.
 */

/**
 * Los valores de una campaña son PLANTILLAS de valor, no valores.
 *
 * `{{1}}` de una plantilla suele ser el nombre de quien lee — y ese cambia
 * en cada envío. Sin esto, una campaña con variables le manda el mismo
 * "Hola Ana" a toda la cartera, que es peor que no personalizar nada.
 *
 * Lo que no se puede resolver queda VACÍO y no rompe el envío: un mensaje
 * que dice "Hola," es feo; uno que no sale porque a alguien le falta el
 * nombre es plata perdida.
 */
export function resolverValores(
  valores: string[],
  contacto: { name?: string | null; phone?: string | null },
): string[] {
  const fuentes: Record<string, string> = {
    'contacto.nombre': (contacto.name ?? '').trim(),
    'contacto.telefono': (contacto.phone ?? '').trim(),
  };
  return valores.map((v) =>
    String(v ?? '').replace(/\{\s*(contacto\.[a-z_]+)\s*\}/gi, (_, clave) => fuentes[String(clave).toLowerCase()] ?? ''),
  );
}

export interface Campana {
  id: string;
  name: string;
  templateId: string;
  status: 'draft' | 'sending' | 'done' | 'cancelled';
  filters: FiltrosSegmento;
  values: string[];
}

function aCampana(row: Record<string, unknown>): Campana {
  return {
    id: row.id as string,
    name: row.name as string,
    templateId: row.template_id as string,
    status: row.status as Campana['status'],
    filters: (row.filters as FiltrosSegmento) ?? {},
    values: (row.values as string[]) ?? [],
  };
}

export async function crearCampana(
  client: PoolClient,
  input: {
    tenantId: string;
    name: string;
    templateId: string;
    filtros: FiltrosSegmento;
    valores?: string[];
    actor?: string;
  },
  deps: {
    /** Cuántas variables pide la plantilla. Se comprueba ACÁ. */
    variablesDePlantilla?: (templateId: string) => Promise<number>;
  } = {},
): Promise<Campana> {
  const name = (input.name ?? '').trim();
  if (!name) throw new Error('La campaña necesita un nombre.');

  // Que los valores calcen con la plantilla se comprueba al CREAR y no al
  // mandar: descubrirlo destinatario por destinatario significa una campaña
  // que falla entera después de apretar el botón.
  if (deps.variablesDePlantilla) {
    const pide = await deps.variablesDePlantilla(input.templateId);
    const hay = (input.valores ?? []).length;
    if (pide !== hay) {
      throw new Error(
        `Esa plantilla necesita ${pide} valor${pide === 1 ? '' : 'es'} y la campaña trae ${hay}. ` +
          'Para el nombre de cada persona usa {contacto.nombre}.',
      );
    }
  }
  const r = await client.query(
    `INSERT INTO campaigns (tenant_id, name, template_id, filters, values, created_by)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6) RETURNING *`,
    [
      input.tenantId,
      name,
      input.templateId,
      JSON.stringify(input.filtros ?? {}),
      JSON.stringify(input.valores ?? []),
      input.actor ?? null,
    ],
  );
  return aCampana(r.rows[0]);
}

/** A quién le llegaría y a cuántos, con la misma consulta del envío. */
export async function previsualizarCampana(
  client: PoolClient,
  input: { tenantId: string; campaignId: string },
): Promise<{ total: number; muestra: Array<{ id: string; name: string | null; phone: string | null }> }> {
  const c = await obtenerCampana(client, input.tenantId, input.campaignId);
  return previsualizarSegmento(client, { tenantId: input.tenantId, filtros: c.filters });
}

export async function obtenerCampana(
  client: PoolClient,
  tenantId: string,
  campaignId: string,
): Promise<Campana> {
  const r = await client.query('SELECT * FROM campaigns WHERE tenant_id = $1 AND id = $2', [
    tenantId,
    campaignId,
  ]);
  if (r.rowCount === 0) throw new Error('Esa campaña no existe en este negocio.');
  return aCampana(r.rows[0]);
}

export interface ResultadoEnvio {
  encolados: number;
  saltados: number;
  motivos: Record<string, number>;
}

/**
 * Manda la campaña. Cada destinatario pasa por su propia decisión y queda
 * registrado, salga o no.
 *
 * `deps` trae lo que no le corresponde saber a este módulo: si la plantilla
 * está aprobada, si la persona consintió, cómo se escribe un mensaje y cómo
 * se encola. Así esto se prueba entero sin red ni proveedor.
 */
export async function enviarCampana(
  client: PoolClient,
  input: { tenantId: string; campaignId: string; actor?: string; requestId?: string },
  deps: {
    calidadDelNumero: () => Promise<'verde' | 'amarillo' | 'rojo'>;
    puedeIniciar: (contactId: string) => Promise<boolean>;
    conversacionDe: (contactId: string) => Promise<string | null>;
    /** Lo que se necesita para personalizar: nombre y teléfono. */
    datosDelContacto?: (contactId: string) => Promise<{ name?: string | null; phone?: string | null }>;
    enviarPlantilla: (args: {
      conversationId: string;
      contactId: string;
      templateId: string;
      valores: string[];
    }) => Promise<{ messageId: string }>;
  },
): Promise<ResultadoEnvio> {
  const campana = await obtenerCampana(client, input.tenantId, input.campaignId);
  if (campana.status !== 'draft') {
    throw new Error(`Esta campaña ya está ${campana.status === 'sending' ? 'saliendo' : 'cerrada'}.`);
  }

  // La calidad del número manda: en rojo no sale nada. En amarillo sale,
  // pero queda dicho en el evento para que se vea en la pantalla.
  const calidad = await deps.calidadDelNumero();
  if (calidad === 'rojo') {
    throw new Error(
      'El número está en calidad ROJA: una campaña ahora es la forma más corta de perderlo. ' +
        'Primero hay que recuperar la calidad.',
    );
  }

  await client.query(
    `UPDATE campaigns SET status = 'sending', started_at = now() WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.campaignId],
  );

  const contactos = await contactosDelSegmento(client, {
    tenantId: input.tenantId,
    filtros: campana.filters,
  });

  const motivos: Record<string, number> = {};
  let encolados = 0;
  let saltados = 0;

  const anotar = async (
    contactId: string,
    status: 'queued' | 'skipped' | 'failed',
    reason: string | null,
    messageId?: string,
  ) => {
    // ON CONFLICT: si el disparo se repite, la misma persona no recibe la
    // misma campaña dos veces.
    const r = await client.query(
      `INSERT INTO campaign_recipients (tenant_id, campaign_id, contact_id, message_id, status, reason)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (campaign_id, contact_id) DO NOTHING
       RETURNING id`,
      [input.tenantId, input.campaignId, contactId, messageId ?? null, status, reason],
    );
    return (r.rowCount ?? 0) > 0;
  };

  for (const contactId of contactos) {
    if (!(await deps.puedeIniciar(contactId))) {
      if (await anotar(contactId, 'skipped', 'sin consentimiento')) {
        saltados += 1;
        motivos['sin consentimiento'] = (motivos['sin consentimiento'] ?? 0) + 1;
      }
      continue;
    }
    const conversationId = await deps.conversacionDe(contactId);
    if (!conversationId) {
      if (await anotar(contactId, 'skipped', 'sin conversación abierta por ese canal')) {
        saltados += 1;
        motivos['sin conversación'] = (motivos['sin conversación'] ?? 0) + 1;
      }
      continue;
    }
    try {
      // Personalizado por destinatario: `{contacto.nombre}` es el nombre de
      // quien lee, no el de la primera persona de la lista.
      const datos = deps.datosDelContacto ? await deps.datosDelContacto(contactId) : {};
      const { messageId } = await deps.enviarPlantilla({
        conversationId,
        contactId,
        templateId: campana.templateId,
        valores: resolverValores(campana.values, datos),
      });
      if (await anotar(contactId, 'queued', null, messageId)) encolados += 1;
    } catch (err) {
      const motivo = (err as Error).message.slice(0, 200);
      if (await anotar(contactId, 'failed', motivo)) {
        saltados += 1;
        motivos[motivo] = (motivos[motivo] ?? 0) + 1;
      }
    }
  }

  await client.query(
    `UPDATE campaigns SET status = 'done', finished_at = now() WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.campaignId],
  );
  await publishEvent(client, {
    name: 'campaign.sent',
    tenantId: input.tenantId,
    payload: { campaignId: input.campaignId, encolados, saltados, calidad },
    actor: input.actor ?? 'system',
    requestId: input.requestId,
  });

  return { encolados, saltados, motivos };
}

/**
 * Cómo le fue: lo que se encoló, lo que se saltó con su motivo, y qué pasó
 * después con cada mensaje (entregado, leído, fallido) según lo que contó
 * el proveedor.
 */
export async function resultadosDeCampana(
  client: PoolClient,
  input: { tenantId: string; campaignId: string },
): Promise<{
  porEstado: Record<string, number>;
  motivos: Array<{ motivo: string; n: number }>;
  entrega: Record<string, number>;
  costoUsd: number;
}> {
  const estados = await client.query(
    `SELECT status, count(*)::int AS n FROM campaign_recipients
      WHERE tenant_id = $1 AND campaign_id = $2 GROUP BY status`,
    [input.tenantId, input.campaignId],
  );
  const motivos = await client.query(
    `SELECT reason, count(*)::int AS n FROM campaign_recipients
      WHERE tenant_id = $1 AND campaign_id = $2 AND reason IS NOT NULL
      GROUP BY reason ORDER BY n DESC`,
    [input.tenantId, input.campaignId],
  );
  const entrega = await client.query(
    `SELECT m.delivery_status, count(*)::int AS n
       FROM campaign_recipients r JOIN messages m ON m.id = r.message_id
      WHERE r.tenant_id = $1 AND r.campaign_id = $2
      GROUP BY m.delivery_status`,
    [input.tenantId, input.campaignId],
  );
  const costo = await client.query(
    `SELECT COALESCE(SUM((m.meta->'costo'->>'amount')::numeric), 0) AS total
       FROM campaign_recipients r JOIN messages m ON m.id = r.message_id
      WHERE r.tenant_id = $1 AND r.campaign_id = $2`,
    [input.tenantId, input.campaignId],
  );

  return {
    porEstado: Object.fromEntries(estados.rows.map((x) => [x.status, x.n])),
    motivos: motivos.rows.map((x) => ({ motivo: x.reason as string, n: x.n as number })),
    entrega: Object.fromEntries(entrega.rows.map((x) => [x.delivery_status ?? 'sin estado', x.n])),
    costoUsd: Number(costo.rows[0].total),
  };
}
