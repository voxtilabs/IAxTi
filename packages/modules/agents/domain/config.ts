// Configuración del runtime (#47, ADR-0011): proveedor y modelo POR TAREA,
// sin deploy. Puro.

export const PROVIDERS = ['google', 'anthropic', 'glm'] as const;
export type Provider = (typeof PROVIDERS)[number];

export const TASKS = [
  'clasificar',
  'sugerir',
  'responder',
  'configurar',
  'conocer',
  'resumir',
  'transcribir',
  // Responderle al DUEÑO sobre sus números (#410). Es tarea propia y no
  // `resumir` porque el que paga la cuenta tiene derecho a elegir con qué
  // modelo se le contesta a él, aparte de con cuál se le contesta a sus
  // clientes — y porque su costo se lee separado en el consumo.
  'analizar',
  // El Agente General (#493, ADR-0025): configura el producto conversando,
  // con TODAS las herramientas de la API. Tarea propia por tres razones y
  // ninguna es estética: usa el modelo que más razona (elegir mal una
  // herramienta entre 195 es peor que responder lento), necesita un tope de
  // salida grande porque hay varios pasos antes de la respuesta, y su costo
  // se lee SEPARADO del de los asistentes que atienden clientes — es gasto
  // de configuración, no de atención.
  'configuracion_conversada',
] as const;
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
/**
 * Desde ADR-0025 §7 (2026-09-25) el proveedor por defecto es GLM — servido
 * por el catálogo de NVIDIA, ver `models.ts`. `z-ai/glm-5.3-flash` para el
 * volumen, `z-ai/glm-5.3` para las tareas pesadas.
 *
 * `transcribir` se queda en Google y no es política: es capacidad. La
 * transcripción entra como PARTE DE AUDIO (file part) y el endpoint de GLM
 * en NVIDIA es de texto. Configurarle GLM a esa tarea fallaría en cada
 * audio recibido.
 */
export const DEFAULT_TASK_MODELS: Record<AgentTask, TaskModel> = {
  clasificar: { provider: 'glm', model: 'z-ai/glm-5.3-flash' },
  sugerir: { provider: 'glm', model: 'z-ai/glm-5.3-flash' },
  responder: { provider: 'glm', model: 'z-ai/glm-5.3-flash' },
  // La tarea pesada: entiende el negocio y propone su configuración.
  configurar: { provider: 'glm', model: 'z-ai/glm-5.3' },
  conocer: { provider: 'glm', model: 'z-ai/glm-5.3-flash' },
  resumir: { provider: 'glm', model: 'z-ai/glm-5.3-flash' },
  transcribir: { provider: 'google', model: 'gemini-flash-latest' },
  analizar: { provider: 'glm', model: 'z-ai/glm-5.3' },
  configuracion_conversada: { provider: 'glm', model: 'z-ai/glm-5.3' },
};

/**
 * Cuánto espacio de SALIDA se le da a cada tarea.
 *
 * Existía un solo número, 1024, escondido como default en el puerto. Con
 * los modelos que razonan eso no es un tope de respuesta: es un tope
 * compartido entre pensar y escribir, y en la primera corrida real una
 * sugerencia de tres líneas se comió 665 pensando.
 *
 * Las tareas no piden lo mismo ni de lejos: `resumir` son tres frases y
 * `configurar` es un pipeline entero con cinco respuestas rápidas y tres
 * plantillas de WhatsApp, con el modelo Pro, que razona más. Un número
 * para todas garantiza que sobre en unas y falte en otras — y faltar acá
 * no se ve como un error, se ve como que el producto no entendió.
 */
export const DEFAULT_TASK_OUTPUT_TOKENS: Record<AgentTask, number> = {
  clasificar: 1024,
  // 665 observados para una sugerencia corta. El doble largo deja aire
  // para una conversación con más historia.
  sugerir: 1500,
  responder: 1500,
  // La más grande del producto por lejos, y encima con el modelo que más
  // razona. Cortarla acá es el onboarding fallando en el primer intento.
  configurar: 4000,
  conocer: 1500,
  resumir: 1024,
  transcribir: 2048,
  // La respuesta es corta, pero antes hay un ida y vuelta de herramientas:
  // pedir el catálogo, pedir la métrica, a veces compararla. El tope se
  // reparte entre esos pasos y la respuesta final.
  analizar: 2000,
  // Varios pasos antes de contestar: buscar entre 195 herramientas, a veces
  // mirar un módulo, y preparar la acción. El tope se reparte entre todo
  // eso y la respuesta final, que además explica qué va a hacer.
  configuracion_conversada: 4000,
};

export interface IaSettings {
  tasks: Record<AgentTask, TaskModel>;
  /** Redacción de PII antes de mandar trazas a Langfuse (SPEC §13). */
  redactPII: boolean;
  /** El modelo MÁS BARATO configurado (#52): con la cuota al 100 %, assist
   *  sigue con este si existe; sin él, se corta con aviso claro. */
  economico: TaskModel | null;
  /** El proveedor único que el negocio pidió, si pidió uno. */
  soloProveedor: Provider | null;
}

/**
 * Los proveedores cuyos términos de datos NO garantizan qué hacen con lo
 * que reciben (ADR-0023).
 *
 * No es una lista de "malos": es una lista de "todavía no tenemos el papel".
 * Sale de acá el día que ese papel exista para nuestra cuenta.
 *
 * `glm` SALIÓ el 2026-09-25 por ADR-0025 §7: decisión del dueño, y la
 * cuenta real sirve GLM por el catálogo de NVIDIA (`integrate.api.nvidia.com`)
 * — el destino de los datos es NVIDIA, no Zhipu directo. El MECANISMO se
 * queda: el próximo proveedor sin papeles entra acá y todo esto vuelve a
 * regir sin escribir código.
 */
const SIN_GARANTIA_DE_DATOS = new Set<string>([]);

/** Proveedores cuyo endpoint no recibe audio ni archivos. */
const SOLO_TEXTO = new Set<string>(['glm']);

/**
 * La única tarea que sobrevive a la redacción.
 *
 * `sugerir` y `responder` tienen que recibir el texto REAL: redactar lo que
 * se le pide interpretar rompe la respuesta. `clasificar` no interpreta,
 * etiqueta — saber si un mensaje es una consulta de precio o un reclamo no
 * necesita el teléfono ni el nombre de quien escribe.
 */
const SOBREVIVE_A_LA_REDACCION = new Set<AgentTask>(['clasificar']);

/** ¿Este prompt sale redactado HACIA EL PROVEEDOR? (distinto de la traza) */
export function vaRedactadoAlProveedor(provider: string, task: AgentTask): boolean {
  return SIN_GARANTIA_DE_DATOS.has(provider) && SOBREVIVE_A_LA_REDACCION.has(task);
}

/**
 * ¿Se le puede dar esta tarea a este proveedor?
 *
 * Un tenant puede configurar lo que quiera; esto es lo que el producto
 * acepta. La configuración que no se acepta no falla: cae al por defecto de
 * la tarea, porque un mensaje de un cliente esperando respuesta no es el
 * lugar para enseñar una política.
 */
export function proveedorPermitidoParaTarea(provider: string, task: AgentTask): boolean {
  // Capacidad, no política: `transcribir` entra como parte de audio y el
  // endpoint de GLM es de texto. Configurárselo fallaría en CADA audio
  // recibido, así que cae al por defecto como cualquier config inválida.
  if (task === 'transcribir' && SOLO_TEXTO.has(provider)) return false;
  if (!SIN_GARANTIA_DE_DATOS.has(provider)) return true;
  return SOBREVIVE_A_LA_REDACCION.has(task);
}

/**
 * El respaldo por proveedor, para el negocio que fija UNO solo.
 *
 * Dos gamas y no una lista por tarea: lo que distingue a `configurar` de
 * `clasificar` es cuánto tiene que razonar, y eso se mantiene igual si el
 * proveedor cambia. Una lista tarea-por-tarea habría que ampliarla cada vez
 * que se agrega una tarea, que es exactamente el error que esto viene a
 * arreglar.
 */
const RESPALDO_POR_PROVEEDOR: Record<string, { liviano: string; pesado: string }> = {
  google: { liviano: 'gemini-flash-latest', pesado: 'gemini-pro-latest' },
  anthropic: { liviano: 'claude-haiku-4-5-20251001', pesado: 'claude-haiku-4-5-20251001' },
  glm: { liviano: 'z-ai/glm-5.3-flash', pesado: 'z-ai/glm-5.3' },
};

/** Las que razonan de verdad: van con el modelo de gama alta. */
const TAREAS_PESADAS = new Set<AgentTask>(['configurar', 'analizar', 'configuracion_conversada']);

export function iaSettings(settings: Record<string, unknown> | null | undefined): IaSettings {
  const raw = (settings?.ia ?? {}) as Partial<{
    tasks: Partial<Record<AgentTask, Partial<TaskModel>>>;
    redactPII: boolean;
    economico: Partial<TaskModel> | null;
    soloProveedor: string | null;
  }>;
  /**
   * «Solo este proveedor», para todo (resguardo de ADR-0025 §7).
   *
   * Era configuración tarea por tarea, y así se rompía solo: el día que el
   * producto agrega una tarea —pasó con `configuracion_conversada`—, el
   * negocio que había pedido solo Gemini empezaba a mandarle datos al otro
   * proveedor SIN QUE NADIE CAMBIARA NADA. Un cliente que pide un proveedor
   * por escrito no puede depender de que alguien se acuerde de ampliarle la
   * lista en el próximo despliegue.
   *
   * Puesto acá, cubre las tareas que existen hoy y las que se agreguen.
   */
  const soloProveedor =
    raw.soloProveedor && PROVIDERS.includes(raw.soloProveedor as Provider)
      ? (raw.soloProveedor as Provider)
      : null;
  const tasks = {} as Record<AgentTask, TaskModel>;
  for (const task of TASKS) {
    if (soloProveedor) {
      // Si la tarea no la acepta —`transcribir` con un proveedor de solo
      // texto—, cae al por defecto: es capacidad, no preferencia, y fallar
      // en cada audio recibido sería peor que respetar la preferencia.
      if (proveedorPermitidoParaTarea(soloProveedor, task)) {
        const gama = RESPALDO_POR_PROVEEDOR[soloProveedor];
        const configurado = raw.tasks?.[task];
        tasks[task] = {
          provider: soloProveedor,
          // Un modelo elegido a mano se respeta si es de ESE proveedor.
          model:
            configurado?.provider === soloProveedor && configurado.model?.trim()
              ? configurado.model.trim()
              : (TAREAS_PESADAS.has(task) ? gama?.pesado : gama?.liviano) ??
                DEFAULT_TASK_MODELS[task].model,
        };
        continue;
      }
      tasks[task] = { ...DEFAULT_TASK_MODELS[task] };
      continue;
    }
    const t = raw.tasks?.[task];
    tasks[task] = {
      provider:
        PROVIDERS.includes(t?.provider as Provider) &&
        proveedorPermitidoParaTarea(t!.provider as Provider, task)
          ? (t!.provider as Provider)
          : DEFAULT_TASK_MODELS[task].provider,
      // El modelo acompaña al proveedor: si el proveedor cayó al por
      // defecto, quedarse con `glm-4.6` apuntando a Google sería un 404 en
      // cada mensaje entrante.
      model:
        PROVIDERS.includes(t?.provider as Provider) &&
        !proveedorPermitidoParaTarea(t!.provider as Provider, task)
          ? DEFAULT_TASK_MODELS[task].model
          : t?.model?.trim() || DEFAULT_TASK_MODELS[task].model,
    };
  }
  // El económico (#52) sirve para CUALQUIER tarea cuando la cuota llega al
  // 100 %, así que un proveedor sin garantías no puede estar ahí: sería la
  // puerta de atrás para que `sugerir` termine en él justo el día de más
  // volumen.
  const economico =
    raw.economico &&
    PROVIDERS.includes(raw.economico.provider as Provider) &&
    !SIN_GARANTIA_DE_DATOS.has(raw.economico.provider as string) &&
    raw.economico.model?.trim() &&
    // Con un proveedor único fijado, el económico tiene que ser de ÉL: si no,
    // la cuota al 100 % sería la puerta de atrás para mandarle datos al que
    // el negocio pidió no usar.
    (!soloProveedor || raw.economico.provider === soloProveedor)
      ? { provider: raw.economico.provider as Provider, model: raw.economico.model.trim() }
      : null;
  return { tasks, redactPII: raw.redactPII !== false, economico, soloProveedor };
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
  // Los por defecto desde ADR-0025. REFERENCIA PROVISIONAL: la tarifa por
  // token del catálogo de NVIDIA no está confirmada para nuestra cuenta
  // (#497 la pide); mientras, la referencia pública de la familia GLM.
  // Se corrige sin deploy por AGENT_PRICES_JSON.
  'glm:z-ai/glm-5.3': { in: 0.6, out: 2.2 },
  'glm:z-ai/glm-5.3-flash': { in: 0.1, out: 0.4 },
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
