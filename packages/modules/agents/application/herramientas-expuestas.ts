import type { PoolClient } from 'pg';
import type { HerramientaExpuesta } from './models';
import {
  HERRAMIENTAS_DE_LECTURA,
  HERRAMIENTAS_QUE_ESCRIBEN_HABILITADAS,
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
  // Los números del negocio (#410). El catálogo va PRIMERO en la
  // descripción de las otras dos a propósito: un modelo que no sabe qué
  // métricas existen se inventa nombres, y la herramienta falla con un
  // "no existe" que gasta un turno.
  'analytics.catalogo': {
    description:
      'Qué se puede preguntar sobre los números del negocio: la lista de métricas con su definición. ' +
      'Úsala ANTES de pedir una métrica si no estás seguro de cómo se llama.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  'analytics.metrica': {
    description:
      'Un número del negocio en un rango de fechas, con su definición. Devuelve lo que hay: si es cero, ' +
      'es cero — nunca estimes ni proyectes un valor que esta herramienta no te dio.',
    parameters: {
      type: 'object',
      properties: {
        metrica: {
          type: 'string',
          description: 'El nombre exacto, como lo devuelve analytics.catalogo.',
        },
        desde: { type: 'string', description: 'Primer día del rango, AAAA-MM-DD.' },
        hasta: { type: 'string', description: 'Último día del rango, AAAA-MM-DD.' },
      },
      required: ['metrica', 'desde', 'hasta'],
      additionalProperties: false,
    },
  },
  'analytics.comparar': {
    description:
      'La misma métrica en dos rangos, con la variación ya calculada. Úsala para "¿voy mejor que el mes ' +
      'pasado?" en vez de pedir dos veces y restar tú.',
    parameters: {
      type: 'object',
      properties: {
        metrica: { type: 'string', description: 'El nombre exacto, como lo devuelve analytics.catalogo.' },
        desdeA: { type: 'string', description: 'Primer día del periodo A, AAAA-MM-DD.' },
        hastaA: { type: 'string', description: 'Último día del periodo A, AAAA-MM-DD.' },
        desdeB: { type: 'string', description: 'Primer día del periodo B, AAAA-MM-DD.' },
        hastaB: { type: 'string', description: 'Último día del periodo B, AAAA-MM-DD.' },
      },
      required: ['metrica', 'desdeA', 'hastaA', 'desdeB', 'hastaB'],
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
  'crm.create_activity': {
    description:
      'Deja una nota o una tarea en la ficha del cliente de esta conversación. No la ve el cliente: es para el equipo. Úsala cuando quede algo pendiente que alguien tiene que hacer o recordar.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Qué pasó o qué hay que hacer, en una frase.' },
        type: {
          type: 'string',
          enum: ['nota', 'tarea', 'llamada', 'reunion'],
          description: 'Por defecto "nota".',
        },
        body: { type: 'string', description: 'Detalle, si hace falta.' },
        dueAt: { type: 'string', description: 'Para cuándo, AAAA-MM-DD. Solo en tareas.' },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  'crm.create_deal': {
    description:
      'Crea una oportunidad de venta para el cliente de esta conversación, en la primera etapa. No la ve el cliente. Úsala cuando muestre intención real de comprar, no por preguntar un precio.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Qué se está vendiendo, en pocas palabras.' },
        value: { type: 'number', description: 'Monto en pesos, SOLO si el cliente lo dijo o está en el catálogo. Nunca lo estimes.' },
      },
      required: ['title'],
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
    (t) => (t in HERRAMIENTAS_DE_LECTURA || t in HERRAMIENTAS_QUE_ESCRIBEN_HABILITADAS) && t in ESQUEMAS,
  );

  // Una escritura por generación (ADR-0017). El bucle tiene tope de cuatro
  // pasos; sin esto, un modelo que se traba podría crear tres oportunidades
  // del mismo cliente en una sola respuesta. La segunda vez recibe el
  // motivo y sigue contestando.
  let yaEscribio: string | null = null;

  return disponibles.map((nombre) => ({
    name: nombre,
    description: ESQUEMAS[nombre].description,
    parameters: ESQUEMAS[nombre].parameters,
    ejecutar: async (args: Record<string, unknown>) => {
      const escribe = nombre in HERRAMIENTAS_QUE_ESCRIBEN_HABILITADAS;
      if (escribe && yaEscribio) {
        return {
          error:
            `Ya usaste "${yaEscribio}" en esta respuesta y solo se permite una escritura por vez. ` +
            'Termina de responderle al cliente; si hace falta otra, la próxima vez.',
        };
      }
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
      // Solo cuenta si de verdad escribió: una llamada rechazada por
      // permiso no gasta el turno.
      if (escribe && r.ok) yaEscribio = nombre;
      // El error se le devuelve AL MODELO, no se lanza: un permiso que
      // falta no es una falla del sistema, es un dato que el modelo tiene
      // que saber para responder sin inventar.
      return r.ok ? r.datos : { error: r.error };
    },
  }));
}
