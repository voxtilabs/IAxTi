import { Body, Controller, Post, Req, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { withTenant } from '@iaxti/db';
import {
  ESQUEMAS,
  HERRAMIENTAS_DE_LECTURA,
  HERRAMIENTAS_QUE_ESCRIBEN_HABILITADAS,
  herramientasExpuestas,
} from '@iaxti/module-agents';
import { getContext } from '@iaxti/module-conversations';
import { getProduct, searchKnowledge } from '@iaxti/module-knowledge';
import { createActivity, createDeal, listPipelines } from '@iaxti/module-crm';
import { catalogoDeMetricas, metricaEnRango } from '@iaxti/module-analytics';
import { RequirePermission } from './authz/decorators';
import { actorCan } from './authz/can';
import type { Actor, WithUser } from './authz/authz.guard';
import { apiPool } from './db';
import { registry } from './registry';

/**
 * El producto como servidor MCP (#419).
 *
 * La idea del issue era "un MCP de todas las funciones". Lo importante no
 * es el protocolo —son cuatro métodos— sino de dónde sale la lista: es la
 * MISMA que usa el asistente de adentro. Mismos esquemas, misma ejecución,
 * mismo rastro. Una segunda lista escrita a mano se desincroniza de la
 * primera en la próxima herramienta que alguien agregue, y el día que pasa
 * nadie se entera: el cliente de afuera simplemente no ve algo que existe.
 *
 * Lo único distinto es quién pregunta. Acá pregunta una API key del tenant,
 * y sus SCOPES son los permisos: los resuelve `actorCan`, la misma función
 * que decide en el resto de la API (ADR-0008). Una key sin
 * `crm.deals.create` no ve esa herramienta en `tools/list` — no es que
 * falle al llamarla: no está. Ofrecer algo que va a fallar es peor que no
 * ofrecerlo, porque el modelo del otro lado lo intenta igual.
 *
 * Las que escriben siguen siendo las dos de ADR-0017. El límite no se
 * afloja porque el cliente sea otro.
 */

/** JSON-RPC 2.0, la parte que el protocolo usa. */
interface Peticion {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const VERSION_DEL_PROTOCOLO = '2025-06-18';

/** Los códigos del estándar. Un error de negocio NO va acá: ver abajo. */
const METODO_DESCONOCIDO = -32601;
const PARAMETROS_INVALIDOS = -32602;

function pool() {
  const p = apiPool();
  if (!p) {
    throw new ServiceUnavailableException({
      code: 'DB_NOT_CONFIGURED',
      message: 'El servidor aún no tiene base de datos configurada. Intenta más tarde.',
    });
  }
  return p;
}

const actorOf = (request: WithUser): Actor => request.actor as Actor;

/**
 * `calendar.get_slots` queda AFUERA por ahora.
 *
 * Los horarios libres son los de UNA persona, y acá no hay ninguna: no hay
 * conversación de la cual deducir quién atiende, y una API key no es
 * nadie de la agenda. Ofrecer la herramienta y contestar con los horarios
 * de cualquiera sería peor que no tenerla. Cuando el esquema acepte
 * `ownerId` explícito, entra.
 */
const SIN_PERSONA_NO_APLICA = new Set(['calendar.get_slots']);

/** Qué permiso pide cada herramienta. Las dos listas, en una sola búsqueda. */
const PERMISO_DE: Record<string, string> = {
  ...HERRAMIENTAS_DE_LECTURA,
  ...HERRAMIENTAS_QUE_ESCRIBEN_HABILITADAS,
};

/**
 * Las herramientas que ESTA key puede usar: declaradas por un módulo
 * ACTIVO, con esquema, y con el permiso concedido a la key.
 */
function disponiblesPara(actor: Actor): string[] {
  const declaradas = new Set<string>();
  for (const salud of registry.health()) {
    if (!salud.active) continue;
    for (const t of registry.manifest(salud.id).tools ?? []) declaradas.add(t);
  }
  return Object.keys(PERMISO_DE).filter(
    (t) =>
      !SIN_PERSONA_NO_APLICA.has(t) &&
      declaradas.has(t) &&
      t in ESQUEMAS &&
      actorCan(actor, PERMISO_DE[t]),
  );
}

@ApiTags('mcp')
@Controller('mcp')
export class McpController {
  @Post()
  @RequirePermission('agents.use')
  @ApiOperation({ summary: 'Servidor MCP: las funciones del producto para una IA de afuera' })
  async rpc(@Req() request: WithUser, @Body() body: Peticion) {
    const actor = actorOf(request);
    const id = body?.id ?? null;
    const metodo = body?.method ?? '';

    // Una notificación (sin `id`) no lleva respuesta. `notifications/
    // initialized` llega SIEMPRE después del handshake: contestarle con un
    // error de método desconocido deja al cliente creyendo que el servidor
    // no habla el protocolo.
    if (body?.id === undefined || body?.id === null) {
      if (metodo.startsWith('notifications/')) return {};
    }

    switch (metodo) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: VERSION_DEL_PROTOCOLO,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'iaxti', version: '1' },
            instructions:
              'Las herramientas trabajan sobre el CRM de este negocio. Lo que no confirme una ' +
              'herramienta, no lo afirmes: este producto no adivina datos de clientes.',
          },
        };

      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: disponiblesPara(actor).map((nombre) => ({
              name: nombre,
              description: ESQUEMAS[nombre].description,
              inputSchema: ESQUEMAS[nombre].parameters,
            })),
          },
        };

      case 'tools/call': {
        const nombre = String(body?.params?.name ?? '');
        const args = (body?.params?.arguments as Record<string, unknown>) ?? {};
        if (!nombre) {
          return {
            jsonrpc: '2.0',
            id,
            error: { code: PARAMETROS_INVALIDOS, message: 'Falta el nombre de la herramienta.' },
          };
        }
        // Que no esté disponible NO es un error de protocolo: es una
        // respuesta con `isError`, para que el modelo del otro lado pueda
        // leer el motivo y seguir conversando en vez de cortar la sesión.
        if (!disponiblesPara(actor).includes(nombre)) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              isError: true,
              content: [
                {
                  type: 'text',
                  text:
                    `La herramienta "${nombre}" no está disponible para esta credencial: ` +
                    'o su módulo no está activo en esta cuenta, o la API key no tiene ese permiso.',
                },
              ],
            },
          };
        }
        return withTenant(pool(), actor.tenantId, async (c) => {
          const [herramienta] = herramientasExpuestas(
            c,
            {
              tenantId: actor.tenantId,
              habilitadas: [nombre],
              actorUserId: actor.userId ?? null,
              requestId: request.requestId,
            },
            {
              actorPuede: (permiso) => actorCan(actor, permiso),
              habilitadas: [nombre],
              getContext: (conversationId) => getContext(c, actor.tenantId, conversationId),
              buscarConocimiento: (query) => searchKnowledge(c, { tenantId: actor.tenantId, query }),
              buscarProducto: (query) => getProduct(c, actor.tenantId, query),
              catalogoDeMetricas: async () => catalogoDeMetricas(),
              metricaDelNegocio: (i) => metricaEnRango(c, { tenantId: actor.tenantId, ...i }),
              // El contacto lo dice quien llama, porque acá no hay ninguna
              // conversación de la cual deducirlo. Igual pasa por el
              // permiso y queda en el libro con la key como actor.
              contactoDeLaConversacion: async () => (args.contactId as string) ?? null,
              crearActividad: (i) =>
                createActivity(c, {
                  tenantId: actor.tenantId,
                  contactId: i.contactId,
                  type: (['nota', 'tarea', 'llamada', 'reunion'].includes(i.type)
                    ? i.type
                    : 'nota') as 'nota',
                  title: i.title,
                  body: i.body,
                  dueAt: i.dueAt ? new Date(`${i.dueAt}T12:00:00Z`) : undefined,
                }),
              crearOportunidad: async (i) => {
                const pipelines = await listPipelines(c, actor.tenantId);
                const pipeline = pipelines[0];
                if (!pipeline) throw new Error('El negocio todavía no tiene un embudo configurado.');
                return createDeal(c, {
                  tenantId: actor.tenantId,
                  contactId: i.contactId,
                  pipelineId: pipeline.id,
                  title: i.title,
                  value: i.value,
                  sourceConversationId: undefined,
                });
              },
            },
          );
          const r = await herramienta.ejecutar(args);
          const fallo = (r as { error?: string }).error;
          return {
            jsonrpc: '2.0',
            id,
            result: {
              isError: Boolean(fallo),
              content: [{ type: 'text', text: fallo ?? JSON.stringify(r) }],
            },
          };
        });
      }

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: METODO_DESCONOCIDO, message: `Este servidor no implementa "${metodo}".` },
        };
    }
  }
}
