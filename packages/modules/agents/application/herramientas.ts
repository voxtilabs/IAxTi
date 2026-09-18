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

/** Las que siguen cerradas, con su motivo en la ADR-0017. */
export const HERRAMIENTAS_QUE_ESCRIBEN = [
  'calendar.book',
  'calendar.reschedule',
  'calendar.cancel',
  'conversations.send_reply',
  'conversations.set_state',
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
