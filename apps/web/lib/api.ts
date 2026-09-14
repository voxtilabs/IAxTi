import type { Session } from '@supabase/supabase-js';
import type { PublicConfig } from '@iaxti/ui/react';

// Cliente mínimo de la API /v1 desde el navegador: Bearer de la sesión +
// X-Tenant-Id del selector. Los errores llegan en voz Pulso ({code, message}).
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export async function apiFetch<T>(
  config: PublicConfig,
  session: Session,
  tenantId: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${config.apiUrl}/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'X-Tenant-Id': tenantId,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const cuerpo = (await res.json().catch(() => null)) as { code?: string; message?: string } | null;
    throw new ApiError(
      cuerpo?.code ?? 'ERROR',
      cuerpo?.message ?? 'Algo salió mal. Intenta de nuevo.',
      res.status,
    );
  }
  return res.json() as Promise<T>;
}

// Formas que devuelve la API de la bandeja (#37).
export interface ConversacionItem {
  id: string;
  contactId: string;
  contactName: string | null;
  contactPhone: string;
  channel: string;
  state: 'new' | 'open' | 'pending' | 'resolved' | 'snoozed';
  ownerId: string | null;
  lastInboundAt: string | null;
  lastMessageAt: string | null;
  unansweredSeconds: number | null;
  snoozedUntil: string | null;
}

export interface ConversacionDetalle extends ConversacionItem {
  contactEmail: string | null;
  contactOptInAt: string | null;
  contactOptedOutAt: string | null;
  firstResponseAt: string | null;
}

/** Ventana de 24 h de WhatsApp desde el último mensaje ENTRANTE (SPEC §11). */
export function enVentana24h(lastInboundAt: string | null): boolean {
  if (!lastInboundAt) return false;
  return Date.now() - new Date(lastInboundAt).getTime() < 24 * 60 * 60 * 1000;
}

export interface Mensaje {
  id: string;
  direction: 'in' | 'out';
  type: string;
  body: string | null;
  deliveryStatus: 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | null;
  authorKind: 'contact' | 'user' | 'agent' | 'system';
  createdAt: string;
}

export interface QuickReplyDto {
  id: string;
  shortcut: string;
  body: string;
  userId: string | null;
}

export interface NotaDto {
  id: string;
  authorId: string;
  body: string;
  mentions: string[];
  createdAt: string;
}

export interface BusquedaHit {
  kind: 'mensaje' | 'nota';
  conversationId: string;
  contactName: string | null;
  contactPhone: string;
  snippet: string;
  createdAt: string;
}

/** Mismo render que el dominio del módulo: {variable} sin valor queda visible. */
export function renderQuickReply(body: string, vars: Record<string, string | null | undefined>): string {
  return body.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (todo, nombre: string) => {
    const valor = vars[nombre];
    return valor === null || valor === undefined || valor === '' ? todo : valor;
  });
}

// La ficha de contacto (#32).
export interface FichaContacto {
  contact: {
    id: string;
    phone: string;
    name: string | null;
    email: string | null;
    rut: string | null;
    origin: string;
    opt_in_at: string | null;
    opted_out_at: string | null;
    last_activity_at: string;
    created_at: string;
  };
  deals: Array<{
    id: string;
    title: string;
    status: 'open' | 'won' | 'lost';
    value: string | null;
    currency: string;
    value_clp: string | null;
    stalled: boolean;
    stage_name: string;
    pipeline_name: string;
    created_at: string;
  }>;
  activities: Array<{
    id: string;
    type: 'llamada' | 'reunion' | 'tarea' | 'nota';
    title: string;
    body: string | null;
    dueAt: string | null;
    doneAt: string | null;
    createdAt: string;
  }>;
}

export function fmtClp(valor: string | number | null): string {
  if (valor === null || valor === undefined) return '—';
  return new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 })
    .format(Number(valor));
}

// Tablero y lista de oportunidades (#33).
export interface StageDto {
  id: string;
  name: string;
  position: number;
  type: 'open' | 'won' | 'lost';
  expectedDays: number | null;
}

export interface PipelineDto {
  id: string;
  name: string;
  stages: StageDto[];
}

export interface DealCardDto {
  id: string;
  title: string;
  status: 'open' | 'won' | 'lost';
  stageId: string;
  stageName: string;
  value: number | null;
  currency: 'CLP' | 'UF' | 'USD';
  valueClp: number | null;
  stalled: boolean;
  ownerId: string | null;
  contactId: string;
  contactName: string | null;
  contactPhone: string;
}

export interface SavedFilterDto {
  id: string;
  name: string;
  filters: Record<string, string>;
}

export interface LossReasonDto {
  id: string;
  label: string;
}

// El copiloto (#48).
export interface SugerenciaDto {
  id: string;
  text: string;
  confidence: number | null;
  intent: string | null;
  leadScore: 'frio' | 'tibio' | 'caliente' | null;
  suggestDeal: boolean;
  expiresAt: string;
}

export interface AnalisisDto {
  /** Modo EFECTIVO del copiloto en esta conversación (#49). */
  mode: 'assist' | 'autonomous' | 'off';
  summary: string | null;
  intent: string | null;
  leadScore: string | null;
  suggestDeal: boolean;
  acciones: Array<{ at: string; que: string; estado: string; feedback: string | null }>;
}
