import { campaignRoutes } from './campaign-routes.generated';

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
  status: 'draft' | 'sending' | 'done' | 'cancelled';
  filters: CampaignFilters;
  values: string[];
}
export interface CampaignListItem extends Campaign {
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  destinatarios: { encolados: number; saltados: number; fallados: number };
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
    segments: () => call<Array<{ id: string; name: string; filters: CampaignFilters }>>('CampanasController_segmentos'),
    create: (body: { name: string; templateId: string; filtros: CampaignFilters; valores: string[] }, key: string) => call<Campaign>('CampanasController_crear', { body, key }),
    preview: (id: string) => call<CampaignPreview>('CampanasController_previa', { id }),
    send: (id: string, key: string) => call<{ encolados: number; saltados: number; motivos: Record<string, number> }>('CampanasController_enviar', { id, key }),
    results: (id: string) => call<CampaignResults>('CampanasController_resultados', { id }),
  };
}
