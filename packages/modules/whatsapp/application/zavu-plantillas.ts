import type { CategoriaPlantilla, EstadoPlantilla } from '../domain/plantillas';
import { baseDeZavu } from './zavu-base';

/**
 * Las plantillas contra la API de Zavu (#44).
 *
 * Las rutas y los nombres de campo salen de la documentación del proveedor y
 * del SDK publicado, no de la memoria. Ayer escribí llamadas de memoria para
 * el adaptador anterior y estaban mal —404 con una ruta, 401 con el otro
 * esquema de auth— hasta probarlas contra la API real; no repito eso.
 *
 *   POST   /v1/templates              crear
 *   GET    /v1/templates/{id}         consultar
 *   POST   /v1/templates/{id}/submit  mandar a revisión de Meta
 *   POST   /v1/templates/sync         importar y refrescar desde Meta
 */

export interface ConfigZavu {
  apiKey: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
}

/** Zavu usa las categorías en mayúscula; nuestro dominio, en minúscula. */
export function categoriaParaZavu(c: CategoriaPlantilla): string {
  return c.toUpperCase();
}

export function categoriaDeZavu(c: string | undefined): CategoriaPlantilla {
  const v = (c ?? '').toLowerCase();
  return (v === 'marketing' || v === 'authentication' ? v : 'utility') as CategoriaPlantilla;
}

/**
 * El estado que manda el proveedor. `paused` y `disabled` no están en el
 * ciclo documentado de Zavu (draft → pending → approved → rejected), pero
 * Meta sí pausa plantillas aprobadas por calidad y esa señal llega en
 * `whatsapp.status`. Se traduce lo que se entienda y lo demás se ignora:
 * inventar un estado es peor que no saberlo.
 */
export function estadoDeZavu(status: string | undefined): EstadoPlantilla | null {
  const v = (status ?? '').toLowerCase();
  if (v === 'draft' || v === 'pending' || v === 'approved' || v === 'rejected') return v;
  if (v === 'paused' || v === 'disabled') return v;
  if (v === 'in_appeal' || v === 'pending_deletion') return null;
  return null;
}

async function llamar<T>(
  cfg: ConfigZavu,
  metodo: 'GET' | 'POST' | 'DELETE',
  ruta: string,
  cuerpo?: unknown,
): Promise<T> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const base = baseDeZavu(cfg.apiBase);
  const res = await fetchImpl(`${base}${ruta}`, {
    method: metodo,
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json',
    },
    ...(cuerpo !== undefined ? { body: JSON.stringify(cuerpo) } : {}),
  });
  if (!res.ok) {
    // El motivo viene en el cuerpo: nombre repetido, categoría inválida,
    // cuenta sin WhatsApp. Sin él, depurar esto es adivinar.
    const motivo = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`Zavu rechazó la plantilla: HTTP ${res.status} ${motivo}`.trim());
  }
  return (await res.json()) as T;
}

export interface PlantillaEnZavu {
  id: string;
  name: string;
  language: string;
  status: EstadoPlantilla | null;
  category: CategoriaPlantilla;
  /** Lo que dice Meta, que puede ir por delante del estado de Zavu. */
  whatsappStatus?: string;
  /** Por qué la rechazó Meta. Es lo único accionable de un rechazo. */
  rejectionReason?: string;
}

function aPlantillaEnZavu(t: Record<string, unknown>): PlantillaEnZavu {
  const whatsapp = (t.whatsapp ?? {}) as { status?: string; rejectedReason?: string };
  const motivo = (whatsapp.rejectedReason ?? t.rejectionReason ?? t.rejectedReason) as
    | string
    | undefined;
  return {
    id: t.id as string,
    name: t.name as string,
    language: t.language as string,
    // El estado de Meta manda sobre el de Zavu cuando se entiende: es el que
    // decide si la plantilla puede salir.
    status: estadoDeZavu(whatsapp.status) ?? estadoDeZavu(t.status as string),
    category: categoriaDeZavu(t.category as string),
    whatsappStatus: whatsapp.status,
    ...(motivo ? { rejectionReason: motivo } : {}),
  };
}

export async function crearEnZavu(
  cfg: ConfigZavu,
  input: {
    name: string;
    language: string;
    body: string;
    category: CategoriaPlantilla;
    footer?: string | null;
    /** Nombres de las variables, solo para documentar la plantilla. */
    variables?: string[];
    buttons?: Array<{ type: string; text?: string; url?: string; phoneNumber?: string }>;
  },
): Promise<PlantillaEnZavu> {
  const t = await llamar<Record<string, unknown>>(cfg, 'POST', '/templates', {
    name: input.name,
    language: input.language,
    body: input.body,
    whatsappCategory: categoriaParaZavu(input.category),
    ...(input.footer ? { footer: input.footer } : {}),
    ...(input.variables?.length ? { variables: input.variables } : {}),
    ...(input.buttons?.length ? { buttons: input.buttons } : {}),
  });
  return aPlantillaEnZavu(t);
}

/** La manda a Meta. El veredicto vuelve por webhook o por consulta. */
export async function enviarARevisionEnZavu(
  cfg: ConfigZavu,
  input: { templateId: string; senderId: string; category: CategoriaPlantilla },
): Promise<PlantillaEnZavu> {
  const t = await llamar<Record<string, unknown>>(
    cfg,
    'POST',
    `/templates/${encodeURIComponent(input.templateId)}/submit`,
    { senderId: input.senderId, category: categoriaParaZavu(input.category) },
  );
  return aPlantillaEnZavu(t);
}

export async function consultarEnZavu(
  cfg: ConfigZavu,
  templateId: string,
): Promise<PlantillaEnZavu> {
  const t = await llamar<Record<string, unknown>>(
    cfg,
    'GET',
    `/templates/${encodeURIComponent(templateId)}`,
  );
  return aPlantillaEnZavu(t);
}

/**
 * Importa de Meta lo que Zavu no tiene y refresca lo que sí.
 *
 * Existe por una razón concreta: **si se pierde un webhook
 * `template.status_changed`, la plantilla se queda en "en revisión" para
 * siempre** y nadie se entera de que ya está aprobada. Un barrido periódico
 * la destraba sin que haya que mirar el panel de Meta.
 */
export async function sincronizarConZavu(
  cfg: ConfigZavu,
  senderId?: string,
): Promise<{ importadas: number; enlazadas: number; actualizadas: number; errores: unknown[] }> {
  const r = await llamar<{
    imported?: number;
    linked?: number;
    updated?: number;
    errors?: unknown[];
  }>(cfg, 'POST', '/templates/sync', senderId ? { senderId } : {});
  return {
    importadas: r.imported ?? 0,
    enlazadas: r.linked ?? 0,
    actualizadas: r.updated ?? 0,
    errores: r.errors ?? [],
  };
}

/**
 * La forma en que Zavu espera un envío de plantilla. El dominio habla de
 * "plantilla"; esto lo traduce a lo que entiende el proveedor, que es donde
 * corresponde: el puerto no tiene por qué saber de `messageType`.
 *
 * Las variables van por POSICIÓN —`{"1": "Ana"}`— porque las plantillas que
 * creamos nosotros se mandan a Meta como posicionales.
 */
/**
 * Todas las plantillas del proveedor. La paginación de Zavu es por cursor
 * (`{items, nextCursor}`) y se recorre entera: si el barrido se quedara en la
 * primera página, las plantillas viejas nunca se reconciliarían. El tope de
 * páginas es un seguro contra un `nextCursor` que no avanza.
 */
export async function listarEnZavu(
  cfg: ConfigZavu,
  senderId?: string,
): Promise<PlantillaEnZavu[]> {
  const todas: PlantillaEnZavu[] = [];
  let cursor: string | undefined;
  for (let pagina = 0; pagina < 50; pagina += 1) {
    const params = new URLSearchParams({ limit: '100' });
    if (cursor) params.set('cursor', cursor);
    if (senderId) params.set('senderId', senderId);
    const r = await llamar<{ items?: Record<string, unknown>[]; nextCursor?: string | null }>(
      cfg,
      'GET',
      `/templates?${params.toString()}`,
    );
    for (const t of r.items ?? []) todas.push(aPlantillaEnZavu(t));
    if (!r.nextCursor || r.nextCursor === cursor) break;
    cursor = r.nextCursor;
  }
  return todas;
}

export function envioDePlantilla(plantilla: {
  providerId?: string | null;
  name?: string;
  valores?: string[];
}): Record<string, unknown> {
  if (!plantilla.providerId) {
    throw new Error(
      `La plantilla "${plantilla.name ?? ''}" no está registrada en el proveedor: mándala a revisión primero.`,
    );
  }
  const variables: Record<string, string> = {};
  (plantilla.valores ?? []).forEach((v, i) => {
    variables[String(i + 1)] = String(v ?? '');
  });
  return {
    messageType: 'template',
    content: {
      templateId: plantilla.providerId,
      ...(Object.keys(variables).length > 0 ? { templateVariables: variables } : {}),
    },
  };
}
