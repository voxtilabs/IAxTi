import type { PoolClient } from 'pg';
import type { HerramientaExpuesta } from './models';
import {
  HERRAMIENTAS_DE_LECTURA,
  ejecutarHerramienta,
  type DepsHerramientas,
} from './herramientas';

/**
 * El cable que faltaba (#240).
 *
 * `ejecutarHerramienta` existía, estaba exportada y tenía tests — y no la
 * llamaba nadie en producción. Era el mismo problema que denunciaba el
 * issue, un piso más arriba: declarado en un lado, aplicado en ninguno.
 *
 * Esto arma la lista que se le ofrece al modelo. Cada herramienta que el
 * modelo pida pasa por `ejecutarHerramienta`, que verifica el permiso de la
 * PERSONA en cada llamada y deja el rastro como acción de la IA.
 *
 * Solo lectura. Las que escriben siguen devolviendo su error explicando que
 * falta la decisión: esta lista ni siquiera se las ofrece, así que el modelo
 * no puede pedir lo que no puede hacer.
 */

/** Qué argumentos toma cada herramienta, en JSON Schema. */
const ESQUEMAS: Record<string, { description: string; parameters: Record<string, unknown> }> = {
  'conversations.get_context': {
    description:
      'Trae el historial y el resumen de esta conversación. Úsala cuando necesites saber qué se habló antes.',
    parameters: {
      type: 'object',
      properties: {
        conversationId: {
          type: 'string',
          description: 'Opcional: por defecto, la conversación en curso.',
        },
      },
      additionalProperties: false,
    },
  },
  'knowledge.search': {
    description:
      'Busca en el material del negocio (políticas, preguntas frecuentes, documentos). Úsala antes de afirmar cualquier cosa que no esté en la conversación.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Qué buscar, en palabras del cliente.' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  'knowledge.get_product': {
    description:
      'Busca un producto o servicio del catálogo con su precio y disponibilidad. El precio SIEMPRE sale de acá: nunca lo inventes ni lo recuerdes de otra conversación.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Nombre o descripción del producto.' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  'calendar.get_slots': {
    description:
      'Los horarios libres de un día. Devuelve tres como máximo. Ofrecer horarios se puede; tomarlos no: para agendar, pasa con una persona.',
    parameters: {
      type: 'object',
      properties: { dia: { type: 'string', description: 'El día, como AAAA-MM-DD.' } },
      required: ['dia'],
      additionalProperties: false,
    },
  },
};

export function herramientasExpuestas(
  client: PoolClient,
  input: {
    tenantId: string;
    /** Las que el agente tiene habilitadas Y su módulo ofrece. */
    habilitadas: string[];
    /**
     * La persona a cuyo nombre actúa la IA. Sin persona no hay herramientas:
     * una llamada sin identidad no se puede verificar contra ningún permiso,
     * y "la IA no puede hacer lo que la persona no podría" dejaría de
     * significar algo.
     */
    actorUserId: string | null;
    agentId?: string;
    conversationId?: string;
    requestId?: string;
  },
  deps: DepsHerramientas,
): HerramientaExpuesta[] {
  if (!input.actorUserId) return [];

  const disponibles = input.habilitadas.filter(
    (t) => t in HERRAMIENTAS_DE_LECTURA && t in ESQUEMAS,
  );

  return disponibles.map((nombre) => ({
    name: nombre,
    description: ESQUEMAS[nombre].description,
    parameters: ESQUEMAS[nombre].parameters,
    ejecutar: async (args: Record<string, unknown>) => {
      const r = await ejecutarHerramienta(
        client,
        {
          tenantId: input.tenantId,
          tool: nombre,
          args,
          actorUserId: input.actorUserId as string,
          agentId: input.agentId,
          conversationId: input.conversationId,
          requestId: input.requestId,
        },
        deps,
      );
      // El error se le devuelve AL MODELO, no se lanza: un permiso que
      // falta no es una falla del sistema, es un dato que el modelo tiene
      // que saber para responder sin inventar.
      return r.ok ? r.datos : { error: r.error };
    },
  }));
}
