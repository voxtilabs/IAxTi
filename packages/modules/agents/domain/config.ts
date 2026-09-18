// Configuración del runtime (#47, ADR-0011): proveedor y modelo POR TAREA,
// sin deploy. Puro.

export const PROVIDERS = ['google', 'anthropic', 'glm'] as const;
export type Provider = (typeof PROVIDERS)[number];

export const TASKS = ['clasificar', 'sugerir', 'responder', 'configurar', 'conocer', 'resumir', 'transcribir'] as const;
export type AgentTask = (typeof TASKS)[number];

export interface TaskModel {
  provider: Provider;
  model: string;
}

/**
 * Los por-defecto de la spec (§13/§40): Flash para clasificar y conocer,
 * Pro para el configurador, y sugerencias en Flash hasta que la decisión
 * del proveedor económico (#54) diga otra cosa. Son DEFAULTS de partida:
 * el override vive en tenants.settings.ia.tasks, no aquí.
 */
/**
 * El modelo por tarea, por ALIAS y no por versión fija.
 *
 * Estaba `gemini-2.5-flash` en las siete, y con la primera llave de verdad
 * que se probó, Google contestó:
 *
 *     404 · This model models/gemini-2.5-flash is no longer available
 *           to new users
 *
 * O sea: una versión fija se retira debajo tuyo, y el producto deja de
 * funcionar para los clientes NUEVOS mientras sigue andando para los
 * viejos. Es de las peores formas de romperse — no aparece en ningún test
 * ni en ningún tenant existente.
 *
 * Los alias (`gemini-flash-latest`, `gemini-pro-latest`) siguen apuntando al
 * modelo vigente de esa familia. El tenant que quiera fijar una versión
 * puede hacerlo: estos son los valores por defecto, no una imposición.
 *
 * El precio es que el modelo cambia solo bajo los pies, y por eso el dataset
 * de regresión (#53) importa más de lo que parecía: es lo que avisa si la
 * versión nueva rinde peor.
 */
export const DEFAULT_TASK_MODELS: Record<AgentTask, TaskModel> = {
  clasificar: { provider: 'google', model: 'gemini-flash-latest' },
  sugerir: { provider: 'google', model: 'gemini-flash-latest' },
  responder: { provider: 'google', model: 'gemini-flash-latest' },
  // La tarea pesada: entiende el negocio y propone su configuración.
  configurar: { provider: 'google', model: 'gemini-pro-latest' },
  conocer: { provider: 'google', model: 'gemini-flash-latest' },
  resumir: { provider: 'google', model: 'gemini-flash-latest' },
  transcribir: { provider: 'google', model: 'gemini-flash-latest' },
};

export interface IaSettings {
  tasks: Record<AgentTask, TaskModel>;
  /** Redacción de PII antes de mandar trazas a Langfuse (SPEC §13). */
  redactPII: boolean;
  /** El modelo MÁS BARATO configurado (#52): con la cuota al 100 %, assist
   *  sigue con este si existe; sin él, se corta con aviso claro. */
  economico: TaskModel | null;
}

export function iaSettings(settings: Record<string, unknown> | null | undefined): IaSettings {
  const raw = (settings?.ia ?? {}) as Partial<{
    tasks: Partial<Record<AgentTask, Partial<TaskModel>>>;
    redactPII: boolean;
    economico: Partial<TaskModel> | null;
  }>;
  const tasks = {} as Record<AgentTask, TaskModel>;
  for (const task of TASKS) {
    const t = raw.tasks?.[task];
    tasks[task] = {
      provider: PROVIDERS.includes(t?.provider as Provider)
        ? (t!.provider as Provider)
        : DEFAULT_TASK_MODELS[task].provider,
      model: t?.model?.trim() || DEFAULT_TASK_MODELS[task].model,
    };
  }
  const economico =
    raw.economico && PROVIDERS.includes(raw.economico.provider as Provider) && raw.economico.model?.trim()
      ? { provider: raw.economico.provider as Provider, model: raw.economico.model.trim() }
      : null;
  return { tasks, redactPII: raw.redactPII !== false, economico };
}

/**
 * Redacción de PII (SPEC §13): teléfonos, correos y RUT enmascarados antes
 * de salir a Langfuse. La base guarda el original; la traza no.
 */
export function redactPII(texto: string): string {
  return texto
    .replace(/\+?56\s?9\s?\d{4}\s?\d{4}|\+?\d{9,15}/g, '[teléfono]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[correo]')
    .replace(/\b\d{1,2}\.?\d{3}\.?\d{3}-[\dkK]\b/g, '[rut]');
}

/**
 * Costos por millón de tokens (USD, referencia 2026-09; §40). Editables por
 * env AGENT_PRICES_JSON sin deploy; el costo guardado es estimación para el
 * panel de consumo, la factura real la manda el proveedor.
 */
const PRECIOS_BASE: Record<string, { in: number; out: number }> = {
  // Los ALIAS, que son los que se usan por defecto. Sin su fila, el costo
  // sale null y el dueño ve consumo sin precio — y "costos visibles, sin
  // margen escondido" es una promesa del producto, no un detalle. Me pasó
  // en la primera corrida real: tokens registrados, cost_usd en null.
  'google:gemini-flash-latest': { in: 0.3, out: 2.5 },
  'google:gemini-flash-lite-latest': { in: 0.1, out: 0.4 },
  'google:gemini-pro-latest': { in: 1.25, out: 10 },
  // Las versiones fijas, para el tenant que prefiera anclarse a una.
  'google:gemini-2.5-flash': { in: 0.3, out: 2.5 },
  'google:gemini-2.5-pro': { in: 1.25, out: 10 },
  'anthropic:claude-haiku-4-5-20251001': { in: 1, out: 5 },
  'glm:glm-4.6': { in: 0.6, out: 2.2 },
};

export function estimateCostUsd(
  provider: string,
  model: string,
  tokensIn: number,
  tokensOut: number,
): number | null {
  let precios = PRECIOS_BASE;
  if (process.env.AGENT_PRICES_JSON) {
    try {
      precios = { ...PRECIOS_BASE, ...JSON.parse(process.env.AGENT_PRICES_JSON) };
    } catch {
      /* json inválido: se queda la base */
    }
  }
  const p = precios[`${provider}:${model}`];
  if (!p) return null;
  return Number(((tokensIn * p.in + tokensOut * p.out) / 1_000_000).toFixed(6));
}
