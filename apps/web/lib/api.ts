import type { Session } from '@supabase/supabase-js';
import type { PublicConfig } from '@iaxti/ui/react';
import type { Quien } from '@iaxti/sdk';

// Cliente mínimo de la API /v1 desde el navegador: Bearer de la sesión +
// X-Tenant-Id del selector. Los errores llegan en voz Pulso ({code, message}).
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    /**
     * El identificador de la petición (#659).
     *
     * La API lo manda en TODA respuesta de error y `apiFetch` lo descartaba, así
     * que la pantalla decía «ya quedó registrado» sin dar con qué. Quien atiende
     * quedaba sin nada que pasarle a quien puede mirar los registros — y desde
     * el celular, que es donde se usa la bandeja, no hay consola del navegador
     * donde ir a buscarlo.
     */
    public readonly requestId: string = '',
  ) {
    super(message);
  }
}

/**
 * Lo que la pantalla muestra cuando algo falla: la frase y, si la hay, la pista
 * técnica para pedir ayuda (#659).
 */
export interface Aviso {
  texto: string;
  /** `code · requestId`, o null cuando no hay nada que copiar. */
  rastro: string | null;
}

/** Arma el aviso a partir de lo que sea que se haya lanzado. */
export function avisoDe(err: unknown): Aviso {
  return {
    texto: err instanceof Error ? err.message : 'Algo salió mal. Intenta de nuevo.',
    rastro: rastroDelError(err),
  };
}

/**
 * El rastro técnico de un error, para pegar en un mensaje pidiendo ayuda.
 *
 * `null` cuando no hay nada que mostrar: un error de red no trae identificador,
 * y un renglón vacío en mono debajo del aviso es ruido.
 */
export function rastroDelError(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const partes = [err.code, err.requestId].filter((p) => p && p !== 'ERROR');
  return partes.length > 0 ? partes.join(' · ') : null;
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
    const cuerpo = (await res.json().catch(() => null)) as {
      code?: string;
      message?: string;
      requestId?: string;
    } | null;
    throw new ApiError(
      cuerpo?.code ?? 'ERROR',
      cuerpo?.message ?? 'Algo salió mal. Intenta de nuevo.',
      res.status,
      cuerpo?.requestId ?? '',
    );
  }
  return res.json() as Promise<T>;
}

/**
 * Lo mismo, pero para una respuesta que NO es JSON: la exportación de
 * contactos viaja como CSV y con su nombre de archivo en la cabecera. Pasarla
 * por `apiFetch` reventaría en `res.json()` justo con la respuesta buena.
 */
export async function apiDescargar(
  config: PublicConfig,
  session: Session,
  tenantId: string,
  path: string,
): Promise<{ texto: string; nombre: string; filas: number | null }> {
  const res = await fetch(`${config.apiUrl}/v1${path}`, {
    headers: { Authorization: `Bearer ${session.access_token}`, 'X-Tenant-Id': tenantId },
  });
  if (!res.ok) {
    const cuerpo = (await res.json().catch(() => null)) as {
      code?: string;
      message?: string;
      requestId?: string;
    } | null;
    throw new ApiError(
      cuerpo?.code ?? 'ERROR',
      cuerpo?.message ?? 'Algo salió mal. Intenta de nuevo.',
      res.status,
      cuerpo?.requestId ?? '',
    );
  }
  const disposicion = res.headers.get('Content-Disposition') ?? '';
  const filas = res.headers.get('X-Filas');
  return {
    texto: await res.text(),
    nombre: /filename="([^"]+)"/.exec(disposicion)?.[1] ?? 'descarga.csv',
    filas: filas === null ? null : Number(filas),
  };
}

/**
 * Lo mismo, para un archivo BINARIO (#709).
 *
 * `apiDescargar` hace `res.text()`, que para un xlsx —que es un zip— corrompe
 * el archivo en silencio: llega, pesa parecido, y Excel dice que está dañado.
 * Un binario se lee como blob o no se lee.
 */
export async function apiDescargarBinario(
  config: PublicConfig,
  session: Session,
  tenantId: string,
  path: string,
): Promise<{ blob: Blob; nombre: string; filas: number | null }> {
  const res = await fetch(`${config.apiUrl}/v1${path}`, {
    headers: { Authorization: `Bearer ${session.access_token}`, 'X-Tenant-Id': tenantId },
  });
  if (!res.ok) {
    const cuerpo = (await res.json().catch(() => null)) as {
      code?: string;
      message?: string;
      requestId?: string;
    } | null;
    throw new ApiError(
      cuerpo?.code ?? 'ERROR',
      cuerpo?.message ?? 'Algo salió mal. Intenta de nuevo.',
      res.status,
      cuerpo?.requestId ?? '',
    );
  }
  const disposicion = res.headers.get('Content-Disposition') ?? '';
  const filas = res.headers.get('X-Filas');
  return {
    blob: await res.blob(),
    nombre: /filename="([^"]+)"/.exec(disposicion)?.[1] ?? 'descarga.xlsx',
    filas: filas === null ? null : Number(filas),
  };
}

// Formas que devuelve la API de la bandeja (#37).
export interface ConversacionItem {
  id: string;
  contactId: string;
  contactName: string | null;
  contactPhone: string | null;
  contactIdentity?: string | null;
  channel: string;
  state: 'new' | 'open' | 'pending' | 'resolved' | 'snoozed';
  ownerId: string | null;
  lastInboundAt: string | null;
  /** Lo decide la API por canal (#639); ausente en una API vieja. */
  ventanaAbierta?: boolean;
  /** Cuándo se cierra, para la etiqueta de «menos de 2 h». */
  cierraA?: string | null;
  lastMessageAt: string | null;
  unansweredSeconds: number | null;
  snoozedUntil: string | null;
}

export interface ConversacionDetalle extends ConversacionItem {
  contactEmail: string | null;
  contactOptInAt: string | null;
  contactOptInChannel: string | null;
  contactOptInEvidence: string | null;
  contactOptedOutAt: string | null;
  firstResponseAt: string | null;
}

/** Ventana de 24 h de WhatsApp desde el último mensaje ENTRANTE (SPEC §11). */
/**
 * Si se puede responder libre lo decide la API (#639).
 *
 * Esto antes era `Date.now() - lastInboundAt < 24 h` acá mismo, **sin mirar el
 * canal**. Dos implementaciones de la misma regla de negocio, en dos lenguajes,
 * y ya se habían separado: en webchat y en el simulador —que no tienen ventana
 * porque el canal es nuestro— la bandeja escondía el campo de respuesta y
 * ofrecía el selector de plantillas, para un canal donde no hay plantillas que
 * mandar. La API decía que sí y la pantalla decía que no.
 *
 * Ahora viene en el detalle. El respaldo cuando el campo NO está —una API más
 * vieja que el front durante un despliegue— es **abierta**, y eso costó una
 * corrección: primero lo dejé cerrado, razonando que ofrecer una plantilla de
 * más es más barato que gastar un intento. El e2e mostró lo que eso significa de
 * verdad: sin el campo, la bandeja **esconde el cuadro de respuesta en TODAS las
 * conversaciones** y nadie puede contestarle a nadie. Un silencio total por un
 * campo ausente es mucho peor que un rechazo explicado.
 *
 * Y abierto no afloja ninguna regla, porque esta no es la cerradura: la ventana
 * la hace cumplir la API (`OUTSIDE_WINDOW`) y el worker antes de despachar. El
 * SPEC §11 lo dice en ese orden — «la bandeja lo muestra y bloquea; la API lo
 * rechaza aunque la UI falle». Acá se muestra; quien manda es la API.
 */
export function ventanaAbierta(detalle: {
  ventanaAbierta?: boolean;
  lastInboundAt: string | null;
}): boolean {
  return detalle.ventanaAbierta ?? true;
}

export interface Mensaje {
  id: string;
  direction: 'in' | 'out';
  type: string;
  body: string | null;
  deliveryStatus: 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | null;
  /**
   * El orden dentro de la conversación, y el cursor para pedir lo anterior
   * (#581). Opcional porque una API vieja no lo manda, y ahí simplemente no se
   * puede paginar: se ve lo último, que es lo de antes.
   */
  seq?: number;
  /**
   * Por qué no salió, ya traducido (#645). Ausente en una API vieja, y ahí la
   * bandeja vuelve a decir solo «No llegó» — que es lo de antes, no algo peor.
   */
  error?: string | null;
  authorKind: 'contact' | 'user' | 'agent' | 'system';
  /** Lo que viajó con el mensaje, ya en R2 y con prefijo por tenant (#42). */
  attachments?: Array<{ key: string; name: string; contentType: string }>;
  /** Los que llegaron y no se alcanzaron a guardar: ya no hay qué abrir. */
  lostAttachments?: number;
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
  contactPhone: string | null;
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
    /** Los campos propios del negocio (#34). La API ya los mandaba. */
    custom: Record<string, unknown> | null;
    /** De qué empresa es (#460). La columna existía desde #217, sin proyectar. */
    company_id: string | null;
    company_name: string | null;
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
    /** Cuándo se cerró, y desde qué etapa se perdió (#695). */
    won_at: string | null;
    lost_at: string | null;
    lost_from_stage: string | null;
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
  createdAt: string;
  title: string;
  status: 'open' | 'won' | 'lost';
  stageId: string;
  stageName: string;
  value: number | null;
  currency: 'CLP' | 'UF' | 'USD';
  valueClp: number | null;
  stalled: boolean;
  ownerId: string | null;
  /** Cuándo se cerró. Se escribía desde el día uno y nadie lo leía (#695). */
  wonAt: string | null;
  lostAt: string | null;
  contactId: string;
  contactName: string | null;
  contactPhone: string | null;
}

/** El embudo leído (#695): conversión por etapa, ciclo de venta y dónde se cae. */
export interface EmbudoDto {
  etapas: Array<{
    stageId: string;
    name: string;
    position: number;
    type: 'open' | 'won' | 'lost';
    entraron: number;
    avanzaron: number;
    conversion: number | null;
    perdidas: number;
  }>;
  ciclo: { muestras: number; promedioDias: number | null; medianaDias: number | null };
  seCaeEn: { stageId: string; name: string; perdidas: number } | null;
  oportunidades: number;
  definiciones: Record<string, string>;
}

/** Un movimiento de etapa de una oportunidad, para la ficha (#695). */
export interface PasoDeEtapaDto {
  from: { stageId: string; name: string } | null;
  to: { stageId: string; name: string };
  reason: string | null;
  actor: string | null;
  at: string;
  backward: boolean;
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
  /**
   * En qué se apoyó (#717). Ausente = no se sabe, `[]` = no consultó nada.
   *
   * No son lo mismo: lo primero es una sugerencia anterior a #699 —cuando la
   * corrida no registraba qué herramientas usaba— y lo segundo es que la
   * registró y no usó ninguna. Decir «sin consultar» de la primera sería
   * afirmar algo que no sabemos.
   */
  herramientas?: string[];
}

export interface AnalisisDto {
  /** Modo EFECTIVO del copiloto en esta conversación (#49). */
  mode: 'assist' | 'autonomous' | 'off';
  summary: string | null;
  intent: string | null;
  leadScore: string | null;
  suggestDeal: boolean;
  acciones: Array<{ at: string; que: string; estado: string; feedback: string | null }>;
  /**
   * La marca manual, con quién la puso (#697).
   *
   * `null` cuando el modo sale del horario del asistente y nadie lo marcó a
   * mano. `set_by` se escribía en cada cambio y la ficha mostraba solo el modo.
   */
  marcaManual: { mode: 'assist' | 'autonomous' | 'off'; puestoPor: Quien | null; puestoEl: string } | null;
}

/** De quién a quién pasó la conversación, con el motivo (#697). */
export interface ReasignacionDto {
  de: Quien | null;
  a: Quien | null;
  motivo: string | null;
  actor: string | null;
  cuando: string;
}

/** Una cita de la agenda (#58, SPEC §16). */
export interface CitaDto {
  id: string;
  contactId: string;
  ownerId: string;
  startsAt: string;
  endsAt: string;
  status:
    | 'proposed'
    | 'confirmed'
    | 'reminded'
    | 'attended'
    | 'no_show'
    | 'cancelled'
    | 'rescheduled';
  title: string | null;
  /** Por qué se cayó (#700). Se escribía desde el día uno y no se mostraba. */
  cancelReason: string | null;
  /** El evento en Google, cuando la cita tiene uno (lo escribirá #57). */
  googleEventId: string | null;
  /**
   * Qué pasó al intentar avisarle a Google, si falló.
   *
   * Una cita cancelada acá y viva allá ocupa una hora que el vendedor ve libre:
   * se dice en la cita en vez de quedar en una columna que nadie mira.
   */
  googleSyncError: string | null;
}

/** Por qué se nos cancelan las visitas (#700). */
export interface CancelacionesDto {
  total: number;
  /** Canceladas sin que nadie escribiera el motivo. Se cuenta aparte a
   *  propósito: «no sabemos» no es un motivo, y mezclarlo haría que el más
   *  frecuente fuera siempre ése. */
  sinMotivo: number;
  motivos: Array<{ motivo: string; n: number }>;
  desincronizadas: Array<{ appointmentId: string; startsAt: string; problema: string }>;
}

/** Un horario libre, en la hora del negocio. */
export interface HuecoDto {
  inicio: string;
  fin: string;
}

/** Una plantilla de WhatsApp y dónde va en la revisión de Meta (#44). */
export interface PlantillaDto {
  id: string;
  name: string;
  language: string;
  category: 'marketing' | 'utility' | 'authentication';
  header: string | null;
  body: string;
  footer: string | null;
  buttons: string[];
  status: 'draft' | 'pending' | 'approved' | 'rejected' | 'paused' | 'disabled';
  providerId: string | null;
  rejectionReason: string | null;
  variables: number;
}

/**
 * Cuántas variables tiene el cuerpo y en qué orden, contadas como las cuenta
 * el servidor: `{{1}}`, `{{2}}`… Se usa para pedir un valor por cada una
 * antes de mandarla, porque `renderizar()` rechaza que falte uno.
 */
export function variablesDePlantilla(body: string): number[] {
  const vistas = new Set<number>();
  for (const m of body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) vistas.add(Number(m[1]));
  return [...vistas].sort((a, b) => a - b);
}

/** El texto tal como lo va a leer la persona, con los valores puestos. */
export function renderPlantilla(body: string, valores: string[]): string {
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => valores[Number(n) - 1] || `{{${n}}}`);
}

/** Un campo propio del negocio (#34, SPEC §10). */
export interface CampoDto {
  id: string;
  entity: 'contact' | 'company' | 'deal';
  key: string;
  label: string;
  type: 'texto' | 'numero' | 'fecha' | 'lista' | 'si_no' | 'moneda';
  required: boolean;
  visibleIa: boolean;
  options: string[];
}

/** Una etiqueta del negocio (#35). El rol es el de Pulso, no un color suelto. */
export interface EtiquetaDto {
  id: string;
  name: string;
  role: 'action' | 'good' | 'warn' | 'bad' | 'info' | 'neutral';
  createdAt: string;
}

/** Una empresa del negocio (#36). Nada se borra: se archiva (SPEC §39). */
export interface EmpresaDto {
  id: string;
  name: string;
  rut: string | null;
  custom: Record<string, unknown>;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
