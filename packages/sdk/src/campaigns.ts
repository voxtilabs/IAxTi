import { campaignRoutes } from './campaign-routes.generated';
import type { Quien } from './quien';

export interface CampaignFilters {
  tagIds?: string[];
  stageIds?: string[];
  sinActividadDias?: number;
  campo?: { key: string; valor: string };
  origen?: string;
}
export interface Campaign {
  id: string;
  name: string;
  templateId: string;
  /**
   * `partial` es nuevo (#609): la campaña salió pero NO completa, porque el
   * canal llegó a su tope diario. Antes ese caso se marcaba `done` y el dueño
   * veía «enviada, 900» con 650 personas que nunca recibieron nada.
   */
  status: 'draft' | 'sending' | 'partial' | 'done' | 'cancelled';
  filters: CampaignFilters;
  values: string[];
  /** Quién la lanzó (#697). `null` si no quedó registrado. */
  creadaPor: Quien | null;
  /** Cuántos eran al lanzar, congelado: el «de 900» de «250 de 900». */
  plannedTotal: number | null;
  /** Por qué se cortó o se detuvo, en español, para mostrárselo tal cual. */
  stopReason: string | null;
  /** Quién la detuvo y cuándo (#610). */
  detenidaPor: Quien | null;
  stopRequestedAt: string | null;
}
export interface CampaignListItem extends Campaign {
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /**
   * `encolados` es encolados, NO entregados — era el bug de #609. Un mensaje
   * que el canal rechazó sigue contando como encolado, porque encolarlo salió
   * bien; `noEntregados` es lo que el canal rechazó.
   */
  destinatarios: {
    encolados: number;
    saltados: number;
    fallados: number;
    noEntregados: number;
  };
}
export interface CampaignPreview {
  total: number;
  muestra: Array<{ id: string; name: string | null; phone: string | null }>;
}
export interface CampaignResults {
  campana: Campaign;
  porEstado: Record<string, number>;
  motivos: Array<{ motivo: string; n: number }>;
  entrega: Record<string, number>;
  costoUsd: number;
}
export interface CampaignTemplate {
  id: string;
  name: string;
  body: string;
  status: string;
  variables: number;
}
export interface CampaignChannel {
  id: string;
  kind: string;
  state: string;
  numbers: Array<{
    id: string;
    displayPhone: string | null;
    quality: 'green' | 'yellow' | 'red' | null;
    businessPausedAt?: string | null;
  }>;
}
export class SdkError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) { super(message); }
}

/** Operaciones del flujo de campañas; rutas generadas desde el OpenAPI de la API. */
export function campaignClient(config: { apiUrl: string; token: string; tenantId: string }) {
  async function call<T>(operation: keyof typeof campaignRoutes, options: { id?: string; body?: unknown; key?: string } = {}): Promise<T> {
    const ruta = campaignRoutes[operation];
    const path = ruta.path.replace('{id}', encodeURIComponent(options.id ?? ''));
    const response = await fetch(`${config.apiUrl.replace(/\/$/, '')}${path}`, {
      method: ruta.method,
      headers: {
        Authorization: `Bearer ${config.token}`, 'X-Tenant-Id': config.tenantId,
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(options.key ? { 'Idempotency-Key': options.key } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || body === null) throw new SdkError(body?.code ?? 'ERROR', body?.message ?? 'No pudimos completar el pedido. Intenta de nuevo.', response.status);
    return body as T;
  }
  return {
    list: () => call<{ campanas: CampaignListItem[]; truncado: boolean }>('CampanasController_listar'),
    access: () => call<Array<{ id: string; acceso: 'completo' | 'solo_lectura' }>>('MeController_accesoDeModulos'),
    templates: () => call<CampaignTemplate[]>('PlantillasController_list'),
    channels: () => call<CampaignChannel[]>('ChannelsController_list'),
    tags: () => call<Array<{ id: string; name: string }>>('TagsController_list'),
    // `creadoPor` (#697): quién armó el segmento. Se escribía desde #75 y la
    // lista no lo proyectaba.
    segments: () =>
      call<Array<{ id: string; name: string; filters: CampaignFilters; creadoPor: Quien | null }>>(
        'CampanasController_segmentos',
      ),
    create: (body: { name: string; templateId: string; filtros: CampaignFilters; valores: string[] }, key: string) => call<Campaign>('CampanasController_crear', { body, key }),
    preview: (id: string) => call<CampaignPreview>('CampanasController_previa', { id }),
    /**
     * A cuántos alcanza un filtro ANTES de crear nada (#460). La otra
     * vista previa necesita una campaña ya creada: para saber si el
     * segmento sirve había que crear un borrador y mirarlo.
     */
    previewSegment: (filtros: CampaignFilters) =>
      call<CampaignPreview>('CampanasController_vistaPrevia', { body: { filtros } }),
    /**
     * Guarda el filtro con un nombre (#480). La pantalla los LEÍA —«partir
     * de un segmento guardado»— y no había forma de crear uno: los que
     * existían habían entrado por la API a mano.
     */
    saveSegment: (name: string, filtros: CampaignFilters) =>
      call<{ id: string; name: string }>('CampanasController_guardar', { body: { name, filtros } }),
    /**
     * Lanza la campaña. **Ya no espera a que termine** (#609): devuelve 202 con
     * el total congelado y la campaña sale por lotes en un job. El progreso se
     * mira con `results`.
     */
    send: (id: string, key: string) =>
      call<{ campana: Campaign; total: number; truncado: boolean; aviso: string | null }>(
        'CampanasController_enviar',
        { id, key },
      ),
    /** Detener una campaña que está saliendo mal (#610). */
    stop: (id: string) =>
      call<{ campana: Campaign; encolados: number; sinTocar: number; aviso: string }>(
        'CampanasController_detener',
        { id },
      ),
    /** Mandar los que quedaron de una campaña a medias (#609). */
    resume: (id: string) =>
      call<{ campana: Campaign }>('CampanasController_seguir', { id }),
    results: (id: string) => call<CampaignResults>('CampanasController_resultados', { id }),
  };
}
