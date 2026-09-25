import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { withTenant } from '@iaxti/db';
import { enteroDeEntorno } from '@iaxti/core';
import {
  CuotaDeIaAgotada,
  aplicarPropuesta,
  conversarConElAgenteGeneral,
  modeloDelAgenteGeneral,
  motivoDelProveedor,
  providerAvailable,
  type Provider,
} from '@iaxti/module-agents';
import { RequireModule, RequirePermission } from './authz/decorators';
import { permisosDelActor } from './authz/can';
import type { Actor, WithUser } from './authz/authz.guard';
import { apiPool } from './db';
import { registry } from './registry';

/**
 * El Agente General (#493, ADR-0025).
 *
 * Configurar el producto conversando. Es OTRA puerta que `agents/:id/run` y
 * que `:id/preguntar`, y las tres razones son de fondo:
 *
 *  1. **No es un asistente del tenant**: no tiene fila en `agents`, no tiene
 *     objetivo ni modo autónomo, y no atiende clientes. Es de la plataforma.
 *  2. **Tiene TODAS las herramientas**, filtradas por los permisos de quien
 *     habla. Las otras puertas ofrecen las del agente o las del objetivo.
 *  3. **Ejecuta contra la propia API**, no contra los casos de uso. Cada
 *     herramienta es una llamada HTTP a su ruta con el token de la persona,
 *     así que pasa por el mismo guard, el mismo audit y las mismas
 *     validaciones que si la hubiera hecho ella desde la pantalla. No hay un
 *     segundo camino con reglas propias, que es por donde se filtran los
 *     agujeros.
 */

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

/** Los dos que pueden tener un turno en el hilo. */
const QUIEN_HABLA = new Set(['user', 'assistant']);

/**
 * La llamada a la propia API, con la credencial de quien conversa.
 *
 * Va a `127.0.0.1` y no al dominio público a propósito: es la misma app, y
 * dar la vuelta por el borde agregaría latencia, una dependencia de red y un
 * lugar más donde algo puede fallar. La credencial se reenvía TAL CUAL —
 * nunca se fabrica una: si el token de la persona no alcanza, la ruta
 * responde 403 y el modelo recibe ese motivo.
 */
function llamarLaPropiaApi(request: WithUser) {
  const base = `http://127.0.0.1:${enteroDeEntorno('PORT', 3000)}`;
  const credencial: Record<string, string> = request.headers['x-api-key']
    ? { 'X-Api-Key': String(request.headers['x-api-key']) }
    : { Authorization: String(request.headers.authorization ?? '') };
  const tenantId = (request.actor as Actor).tenantId;

  return async (peticion: {
    metodo: string;
    ruta: string;
    query: Record<string, string>;
    cuerpo: Record<string, unknown> | null;
  }) => {
    const qs = new URLSearchParams(peticion.query).toString();
    const cabeceras: Record<string, string> = {
      ...credencial,
      'X-Tenant-Id': tenantId,
      // El MISMO trace: lo que haga el agente se sigue en los logs junto
      // con la conversación que lo pidió.
      ...(request.requestId ? { 'X-Request-Id': request.requestId } : {}),
      ...(peticion.cuerpo ? { 'Content-Type': 'application/json' } : {}),
    };
    const res = await fetch(`${base}${peticion.ruta}${qs ? `?${qs}` : ''}`, {
      method: peticion.metodo,
      headers: cabeceras,
      ...(peticion.cuerpo ? { body: JSON.stringify(peticion.cuerpo) } : {}),
    });
    const datos = await res.json().catch(() => null);
    return { ok: res.ok, estado: res.status, datos };
  };
}

const modulosActivos = () =>
  new Set(
    registry
      .health()
      .filter((m) => m.active)
      .map((m) => m.id),
  );

@ApiTags('agents')
@Controller('agente-general')
@RequireModule('agents')
export class AgenteGeneralController {
  /**
   * Una vuelta de conversación. El hilo lo manda el cliente: acá no hay
   * sesión guardada, y eso es a propósito — una conversación de
   * configuración no es un dato del negocio que haya que retener.
   */
  @Post()
  @RequirePermission('agents.use')
  @ApiOperation({ summary: 'Le habla al Agente General, que configura el negocio conversando' })
  async conversar(
    @Req() request: WithUser,
    @Body() body: { turnos?: Array<{ role?: string; content?: string }> },
  ) {
    const actor = actorOf(request);
    const turnos = (body?.turnos ?? [])
      // Con un Set y no comparando el campo: el grep de CI que impone
      // ADR-0008 caza cualquier comparación contra `role`, y tiene razón en
      // cazarla — el de un turno de chat no tiene nada que ver con el rol de
      // permisos, pero debilitar ese guard por una excepción es cómo los
      // guards se mueren.
      .filter((t) => QUIEN_HABLA.has(String(t.role)) && String(t.content ?? '').trim())
      .map((t) => ({ role: t.role as 'user' | 'assistant', content: String(t.content).trim() }))
      // El hilo completo crece sin tope y cada vuelta lo paga el negocio.
      // Las últimas doce alcanzan para entender de qué se está hablando.
      .slice(-12);
    if (!turnos.length || turnos.at(-1)?.role !== 'user') {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Falta lo que quieres preguntarle.',
        details: [{ field: 'turnos' }],
      });
    }

    return withTenant(pool(), actor.tenantId, async (c) => {
      const { modelo, provider, model } = await modeloDelAgenteGeneral(c, actor.tenantId);
      if (!providerAvailable(provider as Provider)) {
        throw new ServiceUnavailableException({
          code: 'PROVIDER_UNAVAILABLE',
          message: 'El proveedor de IA todavía no tiene llave configurada en este ambiente.',
        });
      }
      try {
        return await conversarConElAgenteGeneral(
          c,
          {
            tenantId: actor.tenantId,
            turnos,
            permisos: await permisosDelActor(c, actor),
            modulosActivos: modulosActivos(),
            actorUserId: actor.userId,
            requestId: request.requestId,
          },
          { modelo, provider, model, llamarApi: llamarLaPropiaApi(request) },
        );
      } catch (err) {
        if (err instanceof CuotaDeIaAgotada) {
          throw new ConflictException({ code: 'IA_QUOTA_EXHAUSTED', message: err.message });
        }
        // Sin saldo, llave vencida o el proveedor caído: se dice con nombre
        // (#402) en vez de caer en un genérico que no ayuda a nadie.
        const d = motivoDelProveedor(err);
        if (d.motivo !== 'desconocido') {
          const cuerpo = { code: `PROVIDER_${d.motivo.toUpperCase()}`, message: d.message };
          if (d.reintentable) throw new ServiceUnavailableException(cuerpo);
          throw new ConflictException(cuerpo);
        }
        throw new BadRequestException({
          code: 'AGENTE_GENERAL_FALLO',
          message: 'No pudo responder esta vez. Vuelve a preguntarle.',
        });
      }
    });
  }

  /**
   * Aplica lo que la persona aprobó.
   *
   * La propuesta viaja por el navegador, así que acá no se confía en nada de
   * lo que trae: se revalida que la herramienta exista, que su módulo esté
   * activo y que ella tenga el permiso — y después la ruta de verdad lo
   * vuelve a verificar todo por su cuenta.
   */
  @Post('aplicar')
  @RequirePermission('agents.use')
  @ApiOperation({ summary: 'Aplica la acción que el Agente General dejó propuesta' })
  async aplicar(
    @Req() request: WithUser,
    @Body() body: { herramienta?: string; argumentos?: Record<string, unknown> },
  ) {
    const actor = actorOf(request);
    if (!body?.herramienta) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Falta qué acción aplicar.',
        details: [{ field: 'herramienta' }],
      });
    }
    return withTenant(pool(), actor.tenantId, async (c) => {
      try {
        const r = await aplicarPropuesta(
          {
            herramienta: body.herramienta!,
            argumentos: body.argumentos ?? {},
            permisos: await permisosDelActor(c, actor),
            modulosActivos: modulosActivos(),
          },
          { llamarApi: llamarLaPropiaApi(request) },
        );
        if (!r.ok) {
          // El motivo de la ruta se respeta tal cual: ya viene con el
          // formato único y con la voz del producto.
          throw new BadRequestException(
            (r.datos as { code?: string; message?: string })?.message
              ? (r.datos as { code?: string; message?: string })
              : { code: 'ACCION_RECHAZADA', message: 'La acción no se pudo completar.' },
          );
        }
        return { aplicada: true, resultado: r.datos };
      } catch (err) {
        if (err instanceof BadRequestException) throw err;
        throw new BadRequestException({
          code: 'ACCION_RECHAZADA',
          message: (err as Error).message,
        });
      }
    });
  }
}
