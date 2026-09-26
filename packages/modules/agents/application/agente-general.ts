import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { publishEvent } from '@iaxti/core';
import { incrementUsage } from '@iaxti/module-organizations';
import { DEFAULT_TASK_OUTPUT_TOKENS, estimateCostUsd, iaSettings, redactPII } from '../domain/config';
import { getTenantSettings } from '@iaxti/module-organizations';
import { CATALOGO, herramientasPara, type Herramienta } from './catalogo';
import { aiSdkModelPort, type HerramientaExpuesta, type ModelPort } from './models';
import { getVersionedPrompt, traceGeneration } from './langfuse';
import { afterExecutionQuota, getQuota } from './quota';

/**
 * El Agente General (#493, ADR-0025).
 *
 * Configura el producto CONVERSANDO. Tiene las 195 herramientas del
 * catálogo, que no son otra cosa que las rutas de la propia API — así que
 * cada cosa que hace pasa por los mismos guards, el mismo audit y las
 * mismas validaciones que si la hubiera hecho una persona desde la
 * pantalla. No hay un segundo camino con reglas propias, que es justo por
 * donde se filtran los agujeros.
 *
 * Tres reglas lo gobiernan, y ninguna es negociable:
 *
 *  1. **Actúa con la identidad de QUIEN HABLA.** Las herramientas se filtran
 *     por los permisos de esa persona antes de ofrecérselas al modelo: lo
 *     que ella no podría hacer, el modelo no lo ve. No puede pedir lo que
 *     no puede hacer, y así no gasta un turno en un 403 que no entiende.
 *  2. **Lo irreversible se PROPONE.** Una herramienta marcada `confirmar`
 *     no se ejecuta acá: se devuelve como propuesta con sus argumentos, y
 *     la persona aplica. El modelo recibe de vuelta "quedó esperando", no
 *     "quedó hecho", para que no le mienta a nadie.
 *  3. **Una acción por respuesta.** Con 195 herramientas y un modelo que se
 *     entusiasma, el tope es lo que evita que una conversación deje seis
 *     cosas configuradas que nadie pidió.
 */

/** La cuota del mes se acabó: el controlador la traduce a 409, no a un 500. */
export class CuotaDeIaAgotada extends Error {}

export interface PasoDelAgente {
  herramienta: string;
  modulo: string | null;
  metodo: string;
  ruta: string;
  /** `false` cuando el permiso faltaba o la llamada falló. */
  ok: boolean;
}

export interface PropuestaDelAgente {
  herramienta: string;
  descripcion: string;
  metodo: string;
  ruta: string;
  permiso: string | null;
  argumentos: Record<string, unknown>;
}

export interface RespuestaDelAgente {
  texto: string;
  pasos: PasoDelAgente[];
  /** Lo que espera el visto bueno de la persona. `null` = nada que aplicar. */
  propuesta: PropuestaDelAgente | null;
  tokensIn: number;
  tokensOut: number;
  truncada: boolean;
  /** La corrida en `agent_executions`: costo, latencia y trace. */
  executionId: string;
  costUsd: number | null;
}

/**
 * Lo que el negocio tiene sin terminar (#495).
 *
 * Cada cosa trae POR QUÉ importa y CON QUÉ se arregla, y eso segundo es el
 * punto: el nombre de una herramienta del catálogo, para que el agente no
 * solo diagnostique — pueda ofrecer hacerlo ahí mismo. Un diagnóstico que
 * termina en "anda a Ajustes" no ahorra nada.
 */
export interface LoQueFalta {
  /** En palabras del negocio: «no tienes horarios de atención definidos». */
  que: string;
  /** Qué se rompe hoy por eso. Sin esto el modelo inventa la consecuencia. */
  porQue: string;
  /** La herramienta que lo resuelve, si existe una. `null` = se hace a mano. */
  comoSeArregla: string | null;
  /**
   * `bloquea` = no se puede vender sin eso; `importa` = duele todos los días;
   * `cuandoPuedas` = mejora, no urgencia. El orden de la respuesta sale de
   * acá y no del orden en que se consultó.
   */
  urgencia: 'bloquea' | 'importa' | 'cuandoPuedas';
}

/**
 * Se llama así y no `Diagnostico` a secas porque `channels` ya exporta un
 * `Diagnostico` —el de por qué un canal no anda—, y dos tipos con el mismo
 * nombre en dos contratos es una confusión garantizada en el próximo import.
 */
export interface DiagnosticoDelNegocio {
  falta: LoQueFalta[];
  /** Lo que sí está, para no repetirlo como pendiente. */
  alDia: string[];
  /**
   * Lo que figura hecho y hoy no lo está (`desfase` del onboarding): el
   * registro no retrocede por diseño, así que un paso marcado de más se
   * queda marcado. Es lo que más confunde a un negocio.
   */
  yaNoEstaLoQueFiguraHecho: string[];
}

/** Lo que hace falta de afuera: el modelo y cómo se llama a la propia API. */
export interface DepsDelAgenteGeneral {
  modelo: ModelPort;
  /** Con qué se generó, para el costo y el registro. */
  provider: string;
  model: string;
  /**
   * Llama una ruta de la API con la identidad de quien conversa. La
   * implementación real es una llamada HTTP a la propia API con su token:
   * así el guard, el audit y las validaciones son exactamente los mismos.
   */
  llamarApi: (peticion: {
    metodo: string;
    ruta: string;
    query: Record<string, string>;
    cuerpo: Record<string, unknown> | null;
  }) => Promise<{ ok: boolean; estado: number; datos: unknown }>;
  /**
   * Qué le falta al negocio (#495).
   *
   * Lo arma QUIEN CONOCE TODOS LOS CONTRATOS —la app—, igual que los
   * verificadores del onboarding: `agents` no puede consultar las tablas de
   * calendar, channels ni whatsapp, y no debería poder. Sin esto la
   * herramienta no se ofrece y el agente lo dice en vez de inventar.
   */
  diagnosticar?: () => Promise<DiagnosticoDelNegocio>;
}

/**
 * El nombre del prompt en Langfuse (#496, ADR-0025 §5).
 *
 * El prompt del Agente General se cambia como el de cualquier asistente:
 * versionado afuera, y una versión nueva pasa por la evaluación antes de
 * promoverse. La constante de abajo es el RESPALDO — lo que corre si
 * Langfuse no está configurado, que es el caso en desarrollo.
 *
 * OJO al agregar una herramienta: en producción el prompt sale de Langfuse,
 * así que una línea nueva acá NO llega sola. La herramienta se le ofrece
 * igual —el modelo la ve en `tools`— pero la instrucción de CUÁNDO usarla
 * hay que promoverla en la versión de allá.
 */
export const PROMPT_DEL_AGENTE_GENERAL = 'iaxti/agente-general';

const INSTRUCCION = [
  'Eres IAxTi, el Agente General de la plataforma IAxTi: un CRM conversacional para pymes',
  'chilenas, WhatsApp primero. Le hablas a la persona que atiende o al dueño del negocio.',
  '',
  'Cómo trabajas:',
  '- Español de Chile, tuteo, corto y concreto. Sin jerga técnica: quien te lee atiende clientes,',
  '  no programa. Nunca le muestres nombres de rutas ni de permisos.',
  '- NUNCA afirmes que puedes hacer algo sin haberlo encontrado con buscar_herramienta. Si no',
  '  existe, dilo derecho y ofrece lo más cercano que sí exista.',
  '- Si la herramienta pide confirmación, llama a preparar_accion y avisa que quedó esperando su',
  '  visto bueno. JAMÁS digas que algo quedó hecho si no lo ejecutaste.',
  '- Nunca inventes un precio, un stock, un plazo ni un número del negocio: eso sale de una',
  '  herramienta o no se dice.',
  '- Una acción por respuesta. Si hacen falta varias, haz la primera y ofrece la siguiente.',
  '',
  'Sobre los asistentes del negocio (puedes crearlos):',
  '- Un negocio puede tener VARIOS, cada uno con un objetivo distinto: vender, responder sobre los',
  '  números, confirmar horas. Que sean varios no es un lujo: un asistente con dos objetivos',
  '  contesta peor los dos.',
  '- Antes de crear uno, pide la lista de objetivos y elige de ahí: si inventas un objetivo, el',
  '  asistente nace sin herramientas y no sirve para nada. Un objetivo marcado como no disponible',
  '  dice qué le falta al negocio; ofrece eso primero en vez de crear algo que no va a poder cumplir.',
  '- Pregunta lo que necesitas para que quede a medida —a qué se dedica, cómo le hablan a sus',
  '  clientes, qué quiere lograr— y usa SUS palabras en el detalle del objetivo. No pidas el',
  '  proveedor ni el modelo: eso lo pone el producto.',
  '- Nace en modo asistido: propone y una persona manda. Nunca ofrezcas dejarlo solo de entrada.',
  '- No te presentes de nuevo en cada respuesta.',
].join('\n');

/** Los parámetros que van EN LA RUTA, según el esquema del catálogo. */
function ranuras(h: Herramienta): { ruta: string[]; query: string[] } {
  const props = ((h.argumentos as { properties?: Record<string, Record<string, unknown>> }).properties ??
    {}) as Record<string, Record<string, unknown>>;
  const ruta: string[] = [];
  const query: string[] = [];
  for (const [nombre, esquema] of Object.entries(props)) {
    if (esquema['x-iaxti-en'] === 'ruta') ruta.push(nombre);
    else if (esquema['x-iaxti-en'] === 'query') query.push(nombre);
  }
  return { ruta, query };
}

/**
 * Reparte los argumentos donde van: ruta, query y cuerpo.
 *
 * El modelo manda un objeto plano —para él es más simple— y acá se abre. Lo
 * que el catálogo no marcó como ruta ni query es cuerpo, que es lo correcto:
 * el generador aplana el `@Body` a propósito.
 */
export function repartirArgumentos(
  h: Herramienta,
  args: Record<string, unknown>,
): { ruta: string; query: Record<string, string>; cuerpo: Record<string, unknown> | null } {
  const { ruta: enRuta, query: enQuery } = ranuras(h);
  let ruta = h.ruta;
  for (const nombre of enRuta) {
    ruta = ruta.replace(`{${nombre}}`, encodeURIComponent(String(args[nombre] ?? '')));
  }
  const query: Record<string, string> = {};
  for (const nombre of enQuery) {
    if (args[nombre] !== undefined && args[nombre] !== null) query[nombre] = String(args[nombre]);
  }
  const cuerpo: Record<string, unknown> = {};
  for (const [nombre, valor] of Object.entries(args)) {
    if (!enRuta.includes(nombre) && !enQuery.includes(nombre)) cuerpo[nombre] = valor;
  }
  // GET y DELETE no llevan cuerpo; el resto lo lleva aunque vaya vacío.
  const sinCuerpo = h.metodo === 'GET' || h.metodo === 'DELETE';
  return { ruta, query, cuerpo: sinCuerpo ? null : cuerpo };
}

/** Lo que el modelo ve de una herramienta: sin rutas ni permisos. */
function comoSeLaCuenta(h: Herramienta) {
  return {
    nombre: h.nombre,
    para_que: h.descripcion,
    donde: h.modulo ?? 'el núcleo',
    trato: h.trato,
    argumentos: (h.argumentos as { properties?: Record<string, unknown> }).properties ?? {},
  };
}

export async function conversarConElAgenteGeneral(
  client: PoolClient,
  input: {
    tenantId: string;
    turnos: Array<{ role: 'user' | 'assistant'; content: string }>;
    /** Los permisos de quien habla. La IA no puede lo que ella no podría. */
    permisos: ReadonlySet<string>;
    modulosActivos: ReadonlySet<string>;
    actorUserId?: string;
    /** El MISMO trace desde el request hasta la generación (SPEC §13). */
    requestId?: string;
  },
  deps: DepsDelAgenteGeneral,
): Promise<RespuestaDelAgente> {
  const disponibles = herramientasPara({
    permisos: input.permisos,
    modulosActivos: input.modulosActivos,
  });
  const porNombre = new Map(disponibles.map((h) => [h.nombre, h]));

  // La cuota (#52) se mira ANTES de generar: al 100 %, esta puerta se cierra
  // con explicación y sin gastar. No cae al modelo económico como las tareas
  // de atención — configurar el negocio puede esperar a mañana; contestarle
  // a un cliente que está escribiendo, no.
  const cuota = await getQuota(client, input.tenantId);
  if (cuota.exhausted) {
    throw new CuotaDeIaAgotada(
      `La cuota de IA del mes está completa (${cuota.used} de ${cuota.limit}). ` +
        'Sube de plan para seguir configurando por conversación.',
    );
  }

  const inicio = Date.now();
  const pasos: PasoDelAgente[] = [];
  let propuesta: PropuestaDelAgente | null = null;

  const buscar: HerramientaExpuesta = {
    name: 'buscar_herramienta',
    description:
      'Busca entre las cosas que puedes hacer, por palabras en español. Úsala SIEMPRE antes de ' +
      'afirmar que puedes algo: si no aparece acá, no puedes.',
    parameters: {
      type: 'object',
      properties: {
        consulta: {
          type: 'string',
          description: 'Palabras de lo que se quiere: "agendar hora", "cancelar plan", "etiquetar contacto".',
        },
      },
      required: ['consulta'],
      additionalProperties: false,
    },
    ejecutar: async (args) => {
      const palabras = String(args.consulta ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      if (!palabras.length) return { error: 'Dime qué buscar.' };
      const puntuar = (h: Herramienta) => {
        const heno = `${h.nombre} ${h.descripcion} ${h.modulo ?? ''}`.toLowerCase();
        return palabras.reduce((n, p) => n + (heno.includes(p) ? 1 : 0), 0);
      };
      const halladas = disponibles
        .map((h) => ({ h, p: puntuar(h) }))
        .filter((x) => x.p > 0)
        .sort((a, b) => b.p - a.p)
        .slice(0, 8);
      if (!halladas.length) {
        return {
          encontradas: 0,
          // Con 195 herramientas, "no encontré" casi siempre es la palabra
          // equivocada. Decirle dónde mirar ahorra un turno.
          nota: `Nada con eso. Los módulos que tienes son: ${[...new Set(disponibles.map((h) => h.modulo ?? 'núcleo'))].join(', ')}.`,
        };
      }
      return { encontradas: halladas.length, herramientas: halladas.map((x) => comoSeLaCuenta(x.h)) };
    },
  };

  const preparar: HerramientaExpuesta = {
    name: 'preparar_accion',
    description:
      'Hace la acción, o la deja esperando el visto bueno de la persona cuando no se puede ' +
      'deshacer. Llámala cuando ya sabes qué quiere y con qué datos.',
    parameters: {
      type: 'object',
      properties: {
        herramienta: { type: 'string', description: 'El nombre exacto que devolvió buscar_herramienta.' },
        argumentos: { type: 'object', description: 'Los datos, con los nombres que pide la herramienta.' },
      },
      required: ['herramienta'],
      additionalProperties: false,
    },
    ejecutar: async (args) => {
      const h = porNombre.get(String(args.herramienta ?? ''));
      if (!h) {
        return {
          error: `No tienes "${String(args.herramienta ?? '')}". Búscala primero con buscar_herramienta.`,
        };
      }
      const argumentos = (args.argumentos ?? {}) as Record<string, unknown>;

      if (h.trato === 'confirmar') {
        if (propuesta) {
          return {
            error:
              'Ya dejaste una acción esperando en esta respuesta. Termina de explicarla; la ' +
              'siguiente va después de que la persona decida.',
          };
        }
        propuesta = {
          herramienta: h.nombre,
          descripcion: h.descripcion,
          metodo: h.metodo,
          ruta: h.ruta,
          permiso: h.permiso,
          argumentos,
        };
        pasos.push({ herramienta: h.nombre, modulo: h.modulo, metodo: h.metodo, ruta: h.ruta, ok: true });
        return {
          estado: 'espera_confirmacion',
          nota: 'Se le mostró con sus datos. NO digas que quedó hecho: quedó esperando su visto bueno.',
        };
      }

      const { ruta, query, cuerpo } = repartirArgumentos(h, argumentos);
      const r = await deps.llamarApi({ metodo: h.metodo, ruta, query, cuerpo });
      pasos.push({ herramienta: h.nombre, modulo: h.modulo, metodo: h.metodo, ruta, ok: r.ok });
      if (!r.ok) {
        // El error se le devuelve AL MODELO y no se lanza: un permiso que
        // falta o un dato inválido es información que necesita para
        // responder sin inventar.
        return { error: (r.datos as { message?: string })?.message ?? `No se pudo (${r.estado}).` };
      }
      return { estado: 'hecho', resultado: r.datos };
    },
  };

  /**
   * «¿Qué me falta?» (#495).
   *
   * Es la pregunta que un dueño de pyme hace con esas palabras, y todo el
   * cálculo ya existía —el onboarding mira lo que HAY hoy, no lo que la
   * columna recuerda—. Lo que faltaba era que el agente lo tuviera a mano y
   * lo contara en español, con el arreglo ofrecido en la misma frase.
   */
  const queFalta: HerramientaExpuesta | null = deps.diagnosticar
    ? {
        name: 'que_le_falta_al_negocio',
        description:
          'Revisa el estado real del negocio: qué está sin terminar, por qué importa y con qué se ' +
          'arregla. Úsala cuando pregunten qué les falta, cómo van, o por qué algo no funciona. ' +
          'Después ofrece hacer lo primero de la lista.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        ejecutar: async () => {
          const d = await deps.diagnosticar!();
          pasos.push({
            herramienta: 'que_le_falta_al_negocio',
            modulo: null,
            metodo: 'GET',
            ruta: '(varios módulos)',
            ok: true,
          });
          const orden = { bloquea: 0, importa: 1, cuandoPuedas: 2 } as const;
          return {
            // Ordenado acá y no en el prompt: el modelo respeta un orden que
            // ya viene hecho, y discute uno que le piden calcular.
            falta: [...d.falta]
              .sort((a, b) => orden[a.urgencia] - orden[b.urgencia])
              // El arreglo se ofrece SOLO si quien pregunta puede hacerlo.
              // El diagnóstico lo arma la app mirando los módulos activos, y
              // eso no es lo mismo que los permisos de esta persona: a una
              // vendedora se le ofrecería "crea una plantilla" y recibiría un
              // 403 después de decir que sí. Se le deja el pendiente —tiene
              // que saberlo— y se le quita el botón.
              .map((f) => ({
                ...f,
                comoSeArregla: f.comoSeArregla && porNombre.has(f.comoSeArregla) ? f.comoSeArregla : null,
              })),
            alDia: d.alDia,
            yaNoEstaLoQueFiguraHecho: d.yaNoEstaLoQueFiguraHecho,
            nota:
              d.falta.length === 0
                ? 'No le falta nada de lo que sabemos mirar: dilo así, sin inventar pendientes.'
                : 'Cuenta lo primero con sus palabras y ofrece hacerlo con la herramienta de `comoSeArregla`.',
          };
        },
      }
    : null;

  const res = await deps.modelo.generate({
    system: (await getVersionedPrompt(PROMPT_DEL_AGENTE_GENERAL).catch(() => null)) ?? INSTRUCCION,
    prompt: '',
    mensajes: input.turnos,
    tools: queFalta ? [buscar, preparar, queFalta] : [buscar, preparar],
    // Buscar, a veces mirar de nuevo, preparar, y contestar.
    maxSteps: 6,
    maxOutputTokens: DEFAULT_TASK_OUTPUT_TOKENS.configuracion_conversada,
  });

  const registro = await registrarCorrida(client, {
    tenantId: input.tenantId,
    provider: deps.provider,
    model: deps.model,
    turnos: input.turnos,
    texto: res.text,
    tokensIn: res.tokensIn,
    tokensOut: res.tokensOut,
    latencyMs: Date.now() - inicio,
    traceId: input.requestId ?? randomUUID(),
    actorUserId: input.actorUserId,
    pasos,
  });

  return {
    texto: res.text,
    pasos,
    propuesta,
    tokensIn: res.tokensIn,
    tokensOut: res.tokensOut,
    truncada: Boolean(res.truncada),
    executionId: registro.executionId,
    costUsd: registro.costUsd,
  };
}

/**
 * La corrida queda en `agent_executions` como cualquier otra, con dos
 * diferencias que importan:
 *
 *  - `agent_id` va en NULL: el Agente General no es de ningún tenant, es de
 *    la plataforma. La columna ya lo permitía.
 *  - la tarea es `configuracion_conversada`, así que su costo se lee
 *    SEPARADO del de los asistentes que atienden clientes (ADR-0025): esto
 *    es gasto de configuración, no de atención.
 */
async function registrarCorrida(
  client: PoolClient,
  datos: {
    tenantId: string;
    provider: string;
    model: string;
    turnos: Array<{ role: string; content: string }>;
    texto: string;
    tokensIn: number;
    tokensOut: number;
    latencyMs: number;
    traceId: string;
    actorUserId?: string;
    pasos: PasoDelAgente[];
  },
): Promise<{ executionId: string; costUsd: number | null }> {
  const costUsd = estimateCostUsd(datos.provider, datos.model, datos.tokensIn, datos.tokensOut);
  const ultima = datos.turnos.at(-1)?.content ?? '';
  const fila = await client.query(
    `INSERT INTO agent_executions
       (tenant_id, agent_id, task, provider, model, input, output, tokens_in, tokens_out,
        cost_usd, latency_ms, trace_id, status, explanation)
     VALUES ($1,NULL,'configuracion_conversada',$2,$3,$4,$5,$6,$7,$8,$9,$10,'ok',$11) RETURNING id`,
    [
      datos.tenantId,
      datos.provider,
      datos.model,
      JSON.stringify({ turnos: datos.turnos.length, ultima }),
      // `output` es jsonb: el texto pelado no es JSON válido.
      JSON.stringify({ text: datos.texto, pasos: datos.pasos.map((p) => p.herramienta) }),
      datos.tokensIn,
      datos.tokensOut,
      costUsd,
      datos.latencyMs,
      datos.traceId,
      `El Agente General respondió con ${datos.provider}/${datos.model} en ${datos.latencyMs} ms.` +
        (datos.pasos.length ? ` Usó: ${datos.pasos.map((p) => p.herramienta).join(', ')}.` : ''),
    ],
  );
  await incrementUsage(client, datos.tenantId, 'ia_executions');
  await afterExecutionQuota(client, datos.tenantId, datos.traceId);
  await publishEvent(client, {
    name: 'agent.executed',
    tenantId: datos.tenantId,
    payload: {
      executionId: fila.rows[0].id,
      task: 'configuracion_conversada',
      provider: datos.provider,
      model: datos.model,
      costUsd,
    },
    actor: datos.actorUserId ?? 'system',
    requestId: datos.traceId,
  });
  // A Langfuse va REDACTADO según la política del tenant (SPEC §13).
  const settings = iaSettings(await getTenantSettings(client, datos.tenantId));
  traceGeneration({
    traceId: datos.traceId,
    tenantId: datos.tenantId,
    task: 'configuracion_conversada',
    provider: datos.provider,
    model: datos.model,
    input: settings.redactPII ? redactPII(ultima) : ultima,
    output: settings.redactPII ? redactPII(datos.texto) : datos.texto,
    tokensIn: datos.tokensIn,
    tokensOut: datos.tokensOut,
    latencyMs: datos.latencyMs,
  });
  return { executionId: fila.rows[0].id, costUsd };
}

/**
 * Aplica lo que la persona aprobó.
 *
 * Se revalida TODO: que la herramienta exista, que ella tenga su permiso y
 * que su módulo esté activo. El cliente devuelve la propuesta tal como se
 * la mostramos, y una propuesta que viaja por el navegador es un dato que
 * se puede editar — así que acá no se confía en nada de lo que trae.
 */
export async function aplicarPropuesta(
  input: {
    herramienta: string;
    argumentos: Record<string, unknown>;
    permisos: ReadonlySet<string>;
    modulosActivos: ReadonlySet<string>;
  },
  deps: Pick<DepsDelAgenteGeneral, 'llamarApi'>,
): Promise<{ ok: boolean; estado: number; datos: unknown }> {
  const h = CATALOGO.find((x) => x.nombre === input.herramienta);
  if (!h) throw new Error('Esa acción no existe.');
  if (h.modulo !== null && !input.modulosActivos.has(h.modulo)) {
    throw new Error('Esa parte del producto no está activa en este negocio.');
  }
  if (h.permiso !== null && !input.permisos.has(h.permiso)) {
    throw new Error('No tienes permiso para eso.');
  }
  const { ruta, query, cuerpo } = repartirArgumentos(h, input.argumentos);
  return deps.llamarApi({ metodo: h.metodo, ruta, query, cuerpo });
}


/**
 * El modelo del Agente General para este negocio.
 *
 * Sale de la configuración por tarea del tenant, con el default de la tarea
 * como respaldo — igual que todo el resto del producto. Que sea
 * configurable importa: el negocio que pidió «solo Gemini» lo configura una
 * vez y también aplica acá (resguardo de ADR-0025 §7).
 */
export async function modeloDelAgenteGeneral(
  client: PoolClient,
  tenantId: string,
): Promise<{ modelo: ModelPort; provider: string; model: string }> {
  const settings = iaSettings(await getTenantSettings(client, tenantId));
  const { provider, model } = settings.tasks.configuracion_conversada;
  return { modelo: aiSdkModelPort(provider, model), provider, model };
}
