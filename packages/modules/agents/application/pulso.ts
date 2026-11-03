import type { PoolClient } from 'pg';
import { getContext, isWithinWindow } from '@iaxti/module-conversations';
import { runAgentTask } from './runtime';
import { aiSdkModelPort, type ModelPortFactory } from './models';
import { fechaDeHoy } from '../domain/contexto';
import { inAutonomousHours } from './autonomous';
import type { Agent } from './agents';

/**
 * El pulso del evento (#1210): el agente retoma solo, cada N minutos, a quien
 * tiene la ventana de 24 h abierta.
 *
 * Nace de un caso concreto —un stand, de 8:30 a 18:00, sin plantillas
 * aprobadas— y es la función que más rápido puede costar un número de
 * WhatsApp. Las decisiones que cargan con eso:
 *
 *  1. **Apagado mientras nadie lo prenda.** `activo !== true` es null, no un
 *     valor por defecto razonable: un `limits` vacío, un `{}` heredado o un
 *     `pulso: {}` a medio configurar no pueden ponerse a escribirle a nadie.
 *  2. **Un motivo por cada salto**, no un booleano. «No mandó» puede ser la
 *     ventana cerrada, la hora, el ritmo o el tope, y cada uno se arregla
 *     distinto. Con un `false` suelto, los cuatro se ven igual en el log.
 *  3. **Un tope por persona.** Entre las 8:30 y las 18:00 caben catorce
 *     pulsos de 40 minutos. Catorce mensajes del mismo número al mismo
 *     teléfono en un día es exactamente el patrón que Meta mira.
 */
export interface PulsoConfig {
  /** Minutos que tienen que pasar desde el último saliente. */
  cadaMinutos: number;
  /** Ventana del día en que se puede retomar, `HH:MM`. */
  desde: string;
  hasta: string;
  /** Tope de pulsos por persona. */
  maxPorPersona: number;
}

/** Los valores por defecto SOLO aplican a un pulso ya prendido a propósito. */
const POR_DEFECTO = { cadaMinutos: 40, maxPorPersona: 6 } as const;

/**
 * La configuración del pulso, o null si no hay que mandar nada.
 *
 * `desde` y `hasta` NO tienen valor por defecto, por lo mismo que
 * `inAutonomousHours` devuelve false sin horario: un pulso sin horario
 * escrito escribiría a las tres de la mañana.
 */
export function configDelPulso(limits: Record<string, unknown>): PulsoConfig | null {
  const crudo = limits.pulso;
  if (!crudo || typeof crudo !== 'object' || Array.isArray(crudo)) return null;
  const o = crudo as Record<string, unknown>;
  if (o.activo !== true) return null;
  const desde = typeof o.desde === 'string' ? o.desde : null;
  const hasta = typeof o.hasta === 'string' ? o.hasta : null;
  if (!desde || !hasta) return null;
  const cada = Number(o.cada_minutos);
  const max = Number(o.max_por_persona);
  return {
    desde,
    hasta,
    cadaMinutos: Number.isFinite(cada) && cada > 0 ? cada : POR_DEFECTO.cadaMinutos,
    maxPorPersona: Number.isFinite(max) && max > 0 ? max : POR_DEFECTO.maxPorPersona,
  };
}

export type MotivoDelPulso =
  | 'manda'
  | 'apagado'
  | 'sin_entrante'
  | 'ventana_cerrada'
  | 'fuera_de_horario'
  | 'muy_pronto'
  | 'tope_alcanzado';

/**
 * ¿Le toca pulso a esta conversación, y si no, por qué no?
 *
 * El orden importa y no es estético: primero lo que no depende del reloj
 * (apagado, ventana), después la hora, y al final el ritmo y el tope. Así el
 * motivo que queda escrito es el PRIMERO que impide mandar, que es el que hay
 * que mirar.
 */
export function tocaPulso(input: {
  ahora: Date;
  cfg: PulsoConfig | null;
  canal: string;
  ultimoEntrante: Date | null;
  ultimoSaliente: Date | null;
  pulsosEnviados: number;
  /** La zona del negocio (#1225): sin ella se juzgaría con la del contenedor. */
  zona?: string;
}): { manda: boolean; motivo: MotivoDelPulso } {
  const { cfg } = input;
  if (!cfg) return { manda: false, motivo: 'apagado' };
  if (!input.ultimoEntrante) return { manda: false, motivo: 'sin_entrante' };
  // Sin plantilla aprobada, fuera de la ventana el proveedor no entrega nada:
  // generar el mensaje sería pagarle al modelo por algo que no sale.
  if (!isWithinWindow(input.canal, input.ultimoEntrante)) {
    return { manda: false, motivo: 'ventana_cerrada' };
  }
  if (!inAutonomousHours({ start: cfg.desde, end: cfg.hasta }, input.ahora, input.zona)) {
    return { manda: false, motivo: 'fuera_de_horario' };
  }
  if (input.pulsosEnviados >= cfg.maxPorPersona) {
    return { manda: false, motivo: 'tope_alcanzado' };
  }
  const desde = input.ultimoSaliente ?? input.ultimoEntrante;
  if (input.ahora.getTime() - desde.getTime() < cfg.cadaMinutos * 60_000) {
    return { manda: false, motivo: 'muy_pronto' };
  }
  return { manda: true, motivo: 'manda' };
}

/** El agente que puede dar pulso en este negocio, o null. */
export function agenteConPulso(agentes: Agent[]): { agent: Agent; cfg: PulsoConfig } | null {
  for (const agent of agentes) {
    if (!agent.active) continue;
    const cfg = configDelPulso(agent.limits);
    if (cfg) return { agent, cfg };
  }
  return null;
}

/**
 * El mensaje con que el agente retoma, escrito con ESTA conversación a la
 * vista (#1210).
 *
 * Que lo escriba el modelo y no una plantilla mía no es un lujo: catorce
 * personas recibiendo el mismo texto desde el mismo número es el patrón que
 * Meta mira, y además no sirve —a quien contó que tiene una barbería hay que
 * hablarle de turnos y a quien preguntó el precio, de otra cosa—.
 *
 * Devuelve el texto y NO lo manda. Mandar es del proceso que consume la cola,
 * igual que con la respuesta autónoma: acá no se sabe nada de emisores ni de
 * la política de salida.
 */
export async function textoParaRetomar(
  client: PoolClient,
  input: {
    tenantId: string;
    conversationId: string;
    agent: Agent;
    /** Lo que el negocio sabe, si el módulo de conocimiento está activo. */
    knowledge?: string | null;
    activeModules?: readonly string[];
    requestId?: string;
  },
  modelPortFactory: ModelPortFactory = aiSdkModelPort,
  now: Date = new Date(),
): Promise<{ texto: string | null; motivo?: 'error_del_modelo' | 'vacio' }> {
  const ctx = await getContext(client, input.tenantId, input.conversationId);
  const contexto = [
    `Hoy es ${fechaDeHoy(now)}.`,
    `Cliente: ${ctx.contact.name ?? 'sin nombre'}${ctx.contact.phone ? ` (${ctx.contact.phone})` : ''}.`,
    ctx.summary ? `Resumen de lo anterior: ${ctx.summary}` : null,
    input.knowledge ?? null,
    'Últimos mensajes:',
    ...ctx.lastMessages.map((m) => `${m.direction === 'in' ? 'Cliente' : 'Negocio'}: ${m.body ?? '[adjunto]'}`),
  ]
    .filter(Boolean)
    .join('\n');

  const res = await runAgentTask(
    client,
    {
      tenantId: input.tenantId,
      agent: input.agent,
      task: 'retomar',
      context: contexto,
      conversationId: input.conversationId,
      ...(input.activeModules ? { activeModules: input.activeModules } : {}),
      prompt: FORMATO_RETOMAR,
      ...(input.requestId ? { requestId: input.requestId } : {}),
    },
    modelPortFactory,
  );
  if (res.status === 'failed' || !res.text) return { texto: null, motivo: 'error_del_modelo' };
  const texto = res.text.trim();
  // Un texto vacío no es un fallo del modelo y no se arregla igual: el modelo
  // contestó, con nada. Mandarlo sería dejarle un mensaje en blanco al cliente.
  if (!texto) return { texto: null, motivo: 'vacio' };
  return { texto };
}

/**
 * Lo que se le pide al modelo para retomar.
 *
 * Nadie preguntó nada: este mensaje lo empieza el negocio. Por eso lo primero
 * que dice el formato es que NO hay pregunta que contestar — sin eso el modelo
 * se inventa una («me preguntabas por…») y queda contestando algo que el
 * cliente nunca dijo.
 */
export const FORMATO_RETOMAR = `Escribe UN mensaje corto para retomar esta conversación. Nadie te preguntó nada: este mensaje lo empieza el negocio, así que NO contestes una pregunta que no existe ni digas «me preguntabas por».

Reglas:
- Una o dos frases. Nunca más de 300 caracteres.
- Engancha con algo que esta persona YA dijo en los mensajes de arriba. Si no dijo nada, una razón concreta para volver a escribirle.
- NUNCA inventes precio, stock, plazo ni descuento.
- No repitas lo que ya le dijiste antes: míralo en los últimos mensajes.
- No pidas disculpas por escribir ni digas «perdón por molestar».
- Texto pelado, sin JSON, sin comillas, sin firma: la firma se agrega después.`;

/**
 * Los negocios a barrer para el pulso.
 *
 * De `tenants`, que no filtra por tenant, y el trabajo se hace adentro de
 * `withTenant` — igual que los barridos de vigencias (#502) y de links de
 * pago (#286). Un `SELECT DISTINCT tenant_id FROM conversations` funcionaría
 * hoy solo porque el rol es superusuario, y devolvería cero filas el día que
 * deje de serlo (#370): el pulso se apagaría solo, sin un error en ningún log.
 */
export async function negociosDelPulso(client: Pick<PoolClient, 'query'>): Promise<string[]> {
  const r = await client.query(
    `SELECT id FROM tenants WHERE COALESCE(state, 'active') <> 'deleted' ORDER BY created_at`,
  );
  return r.rows.map((x) => x.id as string);
}
