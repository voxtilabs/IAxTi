import type { PoolClient } from 'pg';
import { writeAudit } from '@iaxti/module-audit';

/**
 * Las herramientas que la IA puede EJECUTAR (#240, SPEC §13).
 *
 * Los manifiestos declaran 16 herramientas, cada agente tiene su
 * `allowed_tools` y `allowedToolsFor()` cruza lo configurado con lo que los
 * módulos activos ofrecen. Lo que faltaba era que alguna de ellas hiciera
 * algo: ninguna tenía implementación.
 *
 * Esta primera tanda es SOLO LECTURA, a propósito. Las que escriben
 * —crear una oportunidad, responderle a un cliente, cambiar el estado de
 * una conversación— son otra conversación y necesitan una decisión que no
 * es técnica: hasta dónde puede actuar la IA sola. Pedirlas acá devuelve un
 * error que lo dice, en vez de hacer de cuenta que no existen.
 *
 * Dos reglas gobiernan cada llamada:
 *
 *  1. **La identidad es la de la PERSONA, no la del agente.** Una
 *     herramienta jamás puede hacer lo que quien la disparó no podría. Se
 *     verifica por llamada y no por agente: el permiso de alguien cambia
 *     mientras la conversación sigue abierta.
 *  2. **Queda en el libro como acción de la IA.** `actor_kind = 'agent'`
 *     con el usuario a cuyo nombre actuó: si se registrara como si la
 *     hubiera hecho la persona, el día que haya que revisar qué pasó no se
 *     va a poder distinguir.
 */

export const HERRAMIENTAS_DE_LECTURA = {
  'conversations.get_context': 'conversations.read',
  'knowledge.search': 'knowledge.read',
  'knowledge.get_product': 'knowledge.read',
  // Ofrecer horarios es leer la agenda; agendar es otra cosa y por eso
  // `calendar.book` sigue en la lista de las que escriben (SPEC §16: "la IA
  // ofrece máximo tres horarios" — ofrecer, no tomar).
  'calendar.get_slots': 'calendar.read',
  // Los números del negocio, para el asistente del DUEÑO (#410). Piden
  // `analytics.read`: un vendedor ve lo suyo, no lo del equipo — la misma
  // regla que ya aplica la pantalla de reportes.
  'analytics.metrica': 'analytics.read',
  'analytics.comparar': 'analytics.read',
  'analytics.catalogo': 'analytics.read',
  // Quién es quien escribe y qué le pasó antes (#440). Estaban declaradas
  // en el manifiesto de crm y sin implementación: el modelo nunca las
  // recibía, así que volvía a preguntar lo que el negocio ya sabía.
  //
  // Son de LECTURA en el sentido estricto: no dejan rastro en la ficha ni
  // cambian nada. Piden el permiso de contactos de la PERSONA, igual que
  // todo lo demás — la IA no puede traer lo que quien atiende no vería.
  'crm.find_contact': 'crm.contacts.read',
  'crm.get_history': 'crm.contacts.read',
} as const;

export type HerramientaDeLectura = keyof typeof HERRAMIENTAS_DE_LECTURA;

/**
 * Las que escriben y SÍ se ejecutan (ADR-0017).
 *
 * El criterio, en dos preguntas: ¿lo ve el cliente? y ¿se puede deshacer?
 * Estas dos quedan adentro del negocio y tienen un estado que las anula —una
 * actividad se cancela, una oportunidad se marca perdida—. Las otras siete
 * salen hacia el cliente o pisan trabajo de una persona.
 */
export const HERRAMIENTAS_QUE_ESCRIBEN_HABILITADAS = {
  'crm.create_activity': 'crm.activities.manage',
  'crm.create_deal': 'crm.deals.create',
} as const;

export type HerramientaQueEscribe = keyof typeof HERRAMIENTAS_QUE_ESCRIBEN_HABILITADAS;

/**
 * Las que un manifiesto declara y todavía no tienen implementación (#440).
 *
 * Van acá CON SU MOTIVO y no en silencio. `herramientasExpuestas` descarta
 * lo que no tiene esquema, así que una herramienta declarada y sin
 * implementar no falla: el modelo simplemente no la recibe y nadie se
 * entera. Es el mismo agujero que estrenando los objetivos (#315), donde
 * tres nombres inventados aportaban cero herramientas y ningún test se
 * ponía rojo.
 *
 * El guard de `tools-que-existen` exige que toda herramienta declarada esté
 * en una de las cuatro listas. Esta es la lista de "todavía no", y tener
 * que escribir el motivo es lo que impide que crezca sola.
 */
export const HERRAMIENTAS_PENDIENTES: Record<string, string> = {
  'crm.create_contact':
    'Crear un contacto desde la IA duplica fichas: el camino de entrada ya lo crea solo cuando ' +
    'alguien escribe, y por otra puerta no hay cómo saber si es la misma persona.',
  'crm.update_contact':
    'Pisa datos que escribió una persona. Necesita la decisión de qué campos y con qué evidencia ' +
    '(ADR-0017 la dejó fuera por eso).',
  'crm.move_deal':
    'Mover una oportunidad de etapa es trabajo del equipo comercial; la IA propone y una persona ' +
    'mueve. Se reevalúa cuando haya medición de acierto (#53).',
  'crm.add_note':
    'Se solapa con `crm.create_activity`, que ya está habilitada y deja mejor rastro. Habría que ' +
    'decidir si la nota interna aporta algo distinto antes de implementarla.',
  'conversations.suggest_reply':
    'La sugerencia NO es una herramienta que el modelo pida: es la salida del copiloto (#48). ' +
    'Declararla como tool fue un arrastre del manifiesto original.',
  'conversations.request_handoff':
    'El escalamiento ya ocurre por el prompt del objetivo y por el modo autónomo (#49), sin pasar ' +
    'por una tool. Implementarla sería un segundo camino a lo mismo.',
};

/** Las que siguen cerradas, con su motivo en la ADR-0017. */
export const HERRAMIENTAS_QUE_ESCRIBEN = [
  'calendar.book',
  'calendar.reschedule',
  'calendar.cancel',
  'conversations.send_reply',
  'conversations.set_state',
  // `crm.update_deal` no la declara ningún manifiesto, y así está bien: no
  // se declara una herramienta que no se quiere ofrecer nunca. Sigue acá
  // porque esta lista es el registro de lo que decidió la ADR-0017, no un
  // espejo de los manifiestos — sacarla haría desaparecer la decisión.
  'crm.update_deal',
  'payments.create_link',
] as const;

export interface ResultadoHerramienta {
  tool: string;
  ok: boolean;
  datos?: unknown;
  error?: string;
}

export interface DepsHerramientas {
  /** ¿La PERSONA tiene este permiso? No el agente: la persona. */
  actorPuede: (permission: string) => Promise<boolean> | boolean;
  /** Las herramientas habilitadas para este agente y módulos activos. */
  habilitadas: string[];
  getContext: (conversationId: string) => Promise<unknown>;
  buscarConocimiento: (query: string) => Promise<unknown>;
  buscarProducto: (query: string) => Promise<unknown>;
  /**
   * Quién es esta persona y qué le pasó antes (#440).
   *
   * Opcionales: sin el módulo crm activo, pedirlas devuelve que no están
   * disponibles, que es la verdad. `buscarContacto` recibe lo que el
   * cliente dijo de sí mismo —un nombre, un teléfono—; `historialDelContacto`
   * trabaja sobre el contacto de ESTA conversación, no sobre uno que el
   * modelo elija: preguntar por el historial de otra persona sería una fuga
   * con forma de herramienta.
   */
  buscarContacto?: (query: string) => Promise<unknown>;
  historialDelContacto?: (contactId: string) => Promise<unknown>;
  /**
   * Los horarios libres de un día. Devuelve TRES como mucho (SPEC §16):
   * una lista larga en un chat no se lee, se abandona.
   */
  horariosLibres?: (dia: string) => Promise<unknown[]>;
  /**
   * Las que ESCRIBEN (ADR-0017). Opcionales: sin ellas, pedirlas devuelve
   * que no están disponibles, que es la verdad — no una excepción.
   */
  crearActividad?: (input: {
    contactId: string;
    type: string;
    title: string;
    body?: string;
    dueAt?: string;
  }) => Promise<unknown>;
  crearOportunidad?: (input: { contactId: string; title: string; value?: number }) => Promise<unknown>;
  /** El contacto de la conversación en curso: la IA no elige a quién. */
  contactoDeLaConversacion?: () => Promise<string | null>;
  /**
   * Los números del negocio (#410). Opcional: sin analytics activo, pedirlos
   * devuelve que no están disponibles, que es la verdad.
   *
   * Devuelve el valor CON su definición, no solo el número. Un asistente que
   * recibe `ganadas: 7` y tiene que explicar qué es "ganadas" lo va a
   * inventar; recibiéndola no.
   */
  metricaDelNegocio?: (input: {
    metrica: string;
    desde: string;
    hasta: string;
  }) => Promise<unknown>;
  catalogoDeMetricas?: () => Promise<unknown>;
}

/**
 * Las fechas que pide una métrica, validadas.
 *
 * Un modelo escribe "2026-13-45" sin pestañear, y Postgres lo rechaza con un
 * error que no le dice nada a nadie. Acá falla con un motivo que el propio
 * modelo puede corregir en el siguiente intento.
 */
function rangoDeFechas(args: Record<string, unknown>, sufijo = ''): { desde: string; hasta: string } {
  const leer = (campo: string) => String(args[`${campo}${sufijo}`] ?? '').trim();
  const desde = leer('desde');
  const hasta = leer('hasta');
  const valida = (v: string, campo: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      throw new Error(`"${campo}${sufijo}" tiene que ser una fecha AAAA-MM-DD; llegó "${v || '(vacío)'}".`);
    }
    if (Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
      throw new Error(`"${v}" no es una fecha que exista.`);
    }
  };
  valida(desde, 'desde');
  valida(hasta, 'hasta');
  if (desde > hasta) throw new Error(`El rango está al revés: "${desde}" es posterior a "${hasta}".`);
  return { desde, hasta };
}

/** La variación entre dos periodos, sin dejarle la aritmética al modelo. */
function variacionEntre(a: unknown, b: unknown): { absoluta: number; porcentual: number | null } {
  const valor = (x: unknown) => Number((x as { valor?: unknown })?.valor ?? 0);
  const va = valor(a);
  const vb = valor(b);
  const absoluta = vb - va;
  // Sin base no hay porcentaje: "subió infinito" no le sirve a nadie.
  return { absoluta, porcentual: va === 0 ? null : Number(((absoluta / va) * 100).toFixed(1)) };
}

export async function ejecutarHerramienta(
  client: PoolClient,
  input: {
    tenantId: string;
    tool: string;
    args: Record<string, unknown>;
    /** La persona a cuyo nombre actúa la IA. */
    actorUserId: string;
    agentId?: string;
    conversationId?: string;
    requestId?: string;
  },
  deps: DepsHerramientas,
): Promise<ResultadoHerramienta> {
  const fallo = async (error: string): Promise<ResultadoHerramienta> => {
    await rastro(client, input, 'denied', error);
    return { tool: input.tool, ok: false, error };
  };

  if ((HERRAMIENTAS_QUE_ESCRIBEN as readonly string[]).includes(input.tool)) {
    return fallo(
      `La herramienta "${input.tool}" no está habilitada: sale hacia el cliente o pisa ` +
        'trabajo de una persona (ADR-0017). Propónselo a quien atiende.',
    );
  }

  const permiso =
    HERRAMIENTAS_DE_LECTURA[input.tool as HerramientaDeLectura] ??
    HERRAMIENTAS_QUE_ESCRIBEN_HABILITADAS[input.tool as HerramientaQueEscribe];
  if (!permiso) return fallo(`No existe una herramienta llamada "${input.tool}".`);

  // Lo que el agente tiene habilitado Y el módulo ofrece. Una herramienta
  // de un módulo apagado no se ejecuta aunque esté en la configuración.
  if (!deps.habilitadas.includes(input.tool)) {
    return fallo(`"${input.tool}" no está habilitada para este agente o su módulo está apagado.`);
  }

  if (!(await deps.actorPuede(permiso))) {
    return fallo(
      `Quien disparó esto no tiene el permiso "${permiso}": la IA no puede hacer lo que la persona no podría.`,
    );
  }

  try {
    let datos: unknown;
    switch (input.tool) {
      case 'conversations.get_context': {
        const conversationId = (input.args.conversationId as string) ?? input.conversationId;
        if (!conversationId) throw new Error('Falta de qué conversación.');
        datos = await deps.getContext(conversationId);
        break;
      }
      case 'analytics.catalogo': {
        if (!deps.catalogoDeMetricas) throw new Error('Los reportes no están disponibles en este negocio.');
        datos = await deps.catalogoDeMetricas();
        break;
      }
      case 'analytics.metrica': {
        if (!deps.metricaDelNegocio) throw new Error('Los reportes no están disponibles en este negocio.');
        const metrica = String(input.args.metrica ?? '').trim();
        if (!metrica) throw new Error('Falta qué métrica.');
        const { desde, hasta } = rangoDeFechas(input.args);
        datos = await deps.metricaDelNegocio({ metrica, desde, hasta });
        break;
      }
      case 'analytics.comparar': {
        if (!deps.metricaDelNegocio) throw new Error('Los reportes no están disponibles en este negocio.');
        const metrica = String(input.args.metrica ?? '').trim();
        if (!metrica) throw new Error('Falta qué métrica.');
        const a = rangoDeFechas(input.args, 'A');
        const b = rangoDeFechas(input.args, 'B');
        const [uno, dos] = await Promise.all([
          deps.metricaDelNegocio({ metrica, desde: a.desde, hasta: a.hasta }),
          deps.metricaDelNegocio({ metrica, desde: b.desde, hasta: b.hasta }),
        ]);
        // La variación se calcula acá y no la deja al modelo: un LLM
        // haciendo aritmética sobre plata es justo lo que no queremos.
        datos = { periodoA: uno, periodoB: dos, variacion: variacionEntre(uno, dos) };
        break;
      }
      case 'knowledge.search': {
        const query = String(input.args.query ?? '').trim();
        if (!query) throw new Error('Falta qué buscar.');
        datos = await deps.buscarConocimiento(query);
        break;
      }
      case 'knowledge.get_product': {
        const query = String(input.args.query ?? '').trim();
        if (!query) throw new Error('Falta qué producto buscar.');
        datos = await deps.buscarProducto(query);
        break;
      }
      case 'crm.find_contact': {
        if (!deps.buscarContacto) throw new Error('La ficha de clientes no está disponible.');
        const query = String(input.args.query ?? '').trim();
        if (!query) throw new Error('Falta a quién buscar.');
        datos = await deps.buscarContacto(query);
        break;
      }
      case 'crm.get_history': {
        if (!deps.historialDelContacto) throw new Error('La ficha de clientes no está disponible.');
        // El contacto sale de la CONVERSACIÓN y no de los argumentos: que el
        // modelo pueda nombrar a cualquiera sería pedirle el historial de
        // otra persona con forma de herramienta.
        const contactId = deps.contactoDeLaConversacion
          ? await deps.contactoDeLaConversacion()
          : null;
        if (!contactId) throw new Error('Esta conversación todavía no tiene una ficha asociada.');
        datos = await deps.historialDelContacto(contactId);
        break;
      }
      case 'calendar.get_slots': {
        if (!deps.horariosLibres) throw new Error('La agenda no está disponible.');
        const dia = String(input.args.dia ?? '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) throw new Error('El día va como AAAA-MM-DD.');
        // TRES como mucho: en un chat, una lista larga no se lee.
        datos = (await deps.horariosLibres(dia)).slice(0, 3);
        break;
      }
      case 'crm.create_activity': {
        if (!deps.crearActividad) throw new Error('El CRM no está disponible.');
        const contactId = await contactoPara(input, deps);
        const title = String(input.args.title ?? '').trim();
        if (!title) throw new Error('Falta el título de la actividad.');
        datos = await deps.crearActividad({
          contactId,
          // 'nota' por defecto: dejar constancia es lo más inocuo que puede
          // hacer, y es lo que casi siempre corresponde.
          type: String(input.args.type ?? 'nota'),
          title,
          body: input.args.body ? String(input.args.body) : undefined,
          dueAt: input.args.dueAt ? String(input.args.dueAt) : undefined,
        });
        break;
      }
      case 'crm.create_deal': {
        if (!deps.crearOportunidad) throw new Error('El CRM no está disponible.');
        const contactId = await contactoPara(input, deps);
        const title = String(input.args.title ?? '').trim();
        if (!title) throw new Error('Falta el título de la oportunidad.');
        const valor = input.args.value === undefined ? undefined : Number(input.args.value);
        if (valor !== undefined && !Number.isFinite(valor)) {
          throw new Error('El monto tiene que ser un número, o no venir.');
        }
        // La etapa NO se elige: nace en la primera abierta (ADR-0017). La IA
        // no gana ni pierde negocios.
        datos = await deps.crearOportunidad({ contactId, title, value: valor });
        break;
      }
      default:
        return fallo(`No existe una herramienta llamada "${input.tool}".`);
    }
    await rastro(client, input, 'ok', null);
    return { tool: input.tool, ok: true, datos };
  } catch (err) {
    return fallo((err as Error).message);
  }
}

/**
 * A quién se le cuelga lo que la IA crea: al contacto de ESTA conversación.
 * El modelo no elige a quién — si pudiera, un nombre mal leído terminaría
 * creándole una oportunidad a otra persona.
 */
async function contactoPara(
  input: { args: Record<string, unknown> },
  deps: DepsHerramientas,
): Promise<string> {
  const id = deps.contactoDeLaConversacion ? await deps.contactoDeLaConversacion() : null;
  if (!id) throw new Error('No sé de qué contacto es esta conversación.');
  return id;
}

/**
 * El rastro. Best-effort como el resto de los registros de seguridad: que
 * falle el libro no puede voltear la llamada, pero que no quede rastro de
 * lo que hizo la IA sí es un problema, así que se avisa por log.
 */
async function rastro(
  client: PoolClient,
  input: {
    tenantId: string;
    tool: string;
    actorUserId: string;
    agentId?: string;
    conversationId?: string;
    requestId?: string;
    args: Record<string, unknown>;
  },
  result: 'ok' | 'denied',
  error: string | null,
): Promise<void> {
  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: input.actorUserId,
    // 'agent': lo hizo la IA a nombre de alguien. Registrarlo como si lo
    // hubiera hecho la persona haría imposible distinguirlo después.
    actorKind: 'agent',
    action: `agent.tool.${input.tool}`,
    resource: input.conversationId ? 'conversation' : 'tenant',
    resourceId: input.conversationId,
    result,
    requestId: input.requestId,
    metadata: { agentId: input.agentId ?? null, args: input.args, error },
  }).catch((err: Error) => {
    console.warn(`[${input.requestId}] no pudimos auditar la herramienta — ${err.message}`);
  });
}
