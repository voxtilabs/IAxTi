import {
  BadGatewayException,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createQueue, redisConnection } from '@iaxti/core';
import { withTenant } from '@iaxti/db';
import {
  ErrorDeZernio,
  ErrorDeHistorial,
  ErrorDelAlta,
  autorizarAprendizajeDeChats,
  baseDeZernio,
  conectarNumeroDesdeLaApp,
  enlaceParaConectarDesdeLaApp,
  estadoDelHistorial,
  numerosParaConectar,
  retirarAutorizacionDeChats,
  secretStoreDelCanal,
  type DependenciasDelAlta,
} from '@iaxti/module-whatsapp';
import { z } from 'zod';
import { RequireModule, RequirePermission } from './authz/decorators';
import { Cuerpo } from './validar';
import type { Actor, WithUser } from './authz/authz.guard';
import { apiPool } from './db';

/**
 * Conectar WhatsApp desde la app (#1393, ADR-0038).
 *
 * El controller valida, arma las dependencias desde el entorno y traduce los
 * errores. El alta vive en `conectarNumeroDesdeLaApp`.
 *
 * Lo que NUNCA hace: devolver una llave o un secreto. La del operador se lee
 * del entorno y se queda acá; la del negocio y el secreto del webhook van de
 * Zernio a la custodia sin pasar por la respuesta.
 */
const ConectarNumero = z.object({
  cuenta: z
    .string({ error: 'Elige el número que quieres conectar.' })
    .trim()
    .min(1, 'Elige el número que quieres conectar.')
    .max(64, 'Elige el número que quieres conectar.'),
  nombre: z.string().trim().max(80, 'El nombre del canal puede tener hasta 80 letras.').optional(),
  /**
   * Cómo usa el negocio ese número hoy (#1405). Opcional a propósito: la
   * pantalla lo manda cuando la dueña lo eligió antes de ir a Meta, y si no
   * viene no se escribe nada en la cuenta — no se adivina.
   */
  modo: z
    .enum(['coexistencia', 'api'], {
      error: 'Elige cómo usas hoy ese número: en la app WhatsApp Business del teléfono, o solo para IAxTi.',
    })
    .optional(),
});

/**
 * El paso 1 ya no va a ciegas (#1405): el modo es obligatorio porque Zernio
 * asume coexistencia cuando el enlace no lo dice, y un número que no vive en
 * la app del teléfono entra al flujo equivocado de Meta. Sin modo, 400 y el
 * mensaje que explica las dos opciones.
 */
const EnlaceDeConexion = z.object({
  modo: z.enum(['coexistencia', 'api'], {
    error: 'Elige cómo usas hoy ese número: en la app WhatsApp Business del teléfono, o solo para IAxTi.',
  }),
});

function dependencias(): DependenciasDelAlta {
  const pool = apiPool();
  const apiKey = process.env.ZERNIO_API_KEY?.trim();
  const baseUrlApi = process.env.API_URL_PUBLIC?.trim();
  if (!pool || !apiKey || !baseUrlApi) {
    // Qué falta va al log; a la persona, qué hacer.
    console.warn(
      `[conectar-whatsapp] falta configuración: ${[!pool && 'base', !apiKey && 'ZERNIO_API_KEY', !baseUrlApi && 'API_URL_PUBLIC']
        .filter(Boolean)
        .join(', ')}`,
    );
    throw new ServiceUnavailableException({
      code: 'WHATSAPP_CONNECT_UNAVAILABLE',
      message: 'Conectar WhatsApp no está disponible en este momento. Escríbenos y lo conectamos contigo.',
    });
  }
  let custodia;
  try {
    custodia = secretStoreDelCanal();
  } catch (err) {
    // La CLASE y el motivo, siempre (#1196): «no está configurada» a secas no
    // separa una variable que falta (`CustodiaIncompleta`, que la nombra) de
    // un disco sin permiso (`CustodiaSinPermiso`) o una llave mal formada. Ni
    // el nombre de la clase ni ese mensaje son secretos.
    const e = err instanceof Error ? err : new Error(String(err));
    console.warn(`[conectar-whatsapp] la custodia de secretos no está disponible: ${e.name}: ${e.message}`);
    throw new ServiceUnavailableException({
      code: 'WHATSAPP_CONNECT_UNAVAILABLE',
      message: 'Conectar WhatsApp no está disponible en este momento. Escríbenos y lo conectamos contigo.',
    });
  }
  return {
    zernio: { apiKey, apiBase: baseDeZernio(), fetchImpl: (...a) => globalThis.fetch(...a) },
    custodia,
    conTenant: (tenantId, fn) => withTenant(pool, tenantId, fn),
    baseUrlApi,
    ambiente: {
      produccion: process.env.IAXTI_ENV === 'production',
      enviosRealesDeclarados: process.env.ZERNIO_ENVIOS_REALES === '1',
    },
  };
}

/** Los errores del alta, con el formato único. Lo inesperado sigue al filtro global. */
function traducir(err: unknown): never {
  if (err instanceof ErrorDelAlta) {
    throw new ConflictException({ code: 'WHATSAPP_CONNECT_REJECTED', message: err.message });
  }
  if (err instanceof ErrorDeZernio) {
    console.warn(`[conectar-whatsapp] Zernio respondió ${err.status}${err.code ? ` (${err.code})` : ''}`);
    throw new BadGatewayException({
      code: 'WHATSAPP_PROVIDER_FAILED',
      message: 'El proveedor de WhatsApp no respondió bien. Intenta de nuevo en unos minutos.',
    });
  }
  throw err;
}

const actorOf = (request: WithUser): Actor => request.actor as Actor;

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

/**
 * La cola de aprender-de-chats (#1406), perezosa: solo se abre si alguien
 * autoriza la lectura. El `jobId` lleva el instante de la autorización para
 * que reautorizar después de retirar nazca un job nuevo: el de la corrida
 * anterior quedó completado en Redis y BullMQ no reusa su id.
 */
let colaAprender: ReturnType<typeof createQueue> | null = null;
function encolarAprendizaje(
  tenantId: string,
  accountId: string,
  requestId: string | undefined,
  autorizadoEl: string,
): Promise<void> {
  colaAprender ??= createQueue('aprender-de-chats', redisConnection());
  return colaAprender
    .add(
      'aprender',
      {
        moduleId: 'whatsapp' as const,
        tenantId,
        accountId,
        ...(requestId ? { requestId } : {}),
        desde: autorizadoEl,
      },
      { jobId: `ap-${accountId}-${autorizadoEl}` },
    )
    .then(() => undefined);
}

/** Los errores del historial, con el formato único. */
function traducirHistorial(err: unknown): never {
  if (err instanceof ErrorDeHistorial) {
    const noEsta = err.message === 'No encontramos ese canal.';
    if (noEsta) {
      throw new NotFoundException({ code: 'CHANNEL_NOT_FOUND', message: 'No encontramos ese canal.' });
    }
    throw new ConflictException({ code: 'WHATSAPP_HISTORY_REJECTED', message: err.message });
  }
  if (err instanceof ErrorDeZernio) {
    console.warn(`[conectar-whatsapp] Zernio respondió ${err.status}${err.code ? ` (${err.code})` : ''}`);
    throw new BadGatewayException({
      code: 'WHATSAPP_PROVIDER_FAILED',
      message: 'El proveedor de WhatsApp no respondió bien. Intenta de nuevo en unos minutos.',
    });
  }
  throw err;
}

@ApiTags('channels')
@Controller('channels/whatsapp')
@RequireModule('channels')
export class ConectarWhatsAppController {
  /** Paso 1: el enlace de Meta, en el perfil de Zernio de este negocio. */
  @Post('enlace')
  @RequireModule('whatsapp')
  @RequirePermission('channels.manage')
  @ApiOperation({ summary: 'Crea el enlace para conectar un número de WhatsApp a este negocio' })
  async enlace(@Req() request: WithUser, @Cuerpo(EnlaceDeConexion) body: z.infer<typeof EnlaceDeConexion>): Promise<{ url: string }> {
    const actor = actorOf(request);
    const deps = dependencias();
    const nombre = await deps.conTenant(actor.tenantId, async (c) => {
      const r = await c.query<{ name: string }>('SELECT name FROM tenants WHERE id = $1', [actor.tenantId]);
      return r.rows[0]?.name ?? 'Negocio';
    });
    const web = process.env.APP_URL_PUBLIC?.trim();
    try {
      return await enlaceParaConectarDesdeLaApp(deps, {
        tenantId: actor.tenantId,
        nombreDelNegocio: nombre,
        modo: body.modo,
        // A dónde vuelve después de Meta. Sale del entorno, nunca del pedido:
        // un `redirect_url` del cliente sería una redirección abierta.
        ...(web ? { volverA: `${web.replace(/\/+$/, '')}/ajustes/canales?whatsapp=volvio` } : {}),
      });
    } catch (err) {
      traducir(err);
    }
  }

  /** Paso 2: los números que el negocio dejó conectados en su perfil. */
  @Get('numeros')
  @RequireModule('whatsapp')
  @RequirePermission('channels.manage')
  @ApiOperation({ summary: 'Lista los números de WhatsApp listos para conectar a este negocio' })
  async numeros(@Req() request: WithUser) {
    const actor = actorOf(request);
    try {
      return await numerosParaConectar(dependencias(), { tenantId: actor.tenantId });
    } catch (err) {
      traducir(err);
    }
  }

  /** Paso 3: el alta. La llave y el secreto quedan en la custodia, nunca en la respuesta. */
  @Post('conectar')
  @RequireModule('whatsapp')
  @RequirePermission('channels.manage')
  @ApiOperation({ summary: 'Conecta a este negocio un número de WhatsApp ya autorizado en Meta' })
  async conectar(@Req() request: WithUser, @Cuerpo(ConectarNumero) body: z.infer<typeof ConectarNumero>) {
    const actor = actorOf(request);
    try {
      const { account, renovada } = await conectarNumeroDesdeLaApp(dependencias(), {
        tenantId: actor.tenantId,
        cuenta: body.cuenta,
        ...(body.nombre ? { nombre: body.nombre } : {}),
        ...(body.modo ? { modo: body.modo } : {}),
        actor: actor.userId,
        actorKind: 'user',
        ...(request.requestId ? { requestId: request.requestId } : {}),
      });
      // Solo lo que la pantalla necesita. Las referencias no salen: no le
      // sirven a nadie afuera y dicen dónde vive el secreto.
      return { id: account.id, name: account.name, state: account.state, renovada };
    } catch (err) {
      traducir(err);
    }
  }

  /**
   * Aprender de los chats del número (#1406, ADR-0039): la autorización del
   * dueño para leer los últimos 50 chats. Los dos módulos que la corrida
   * necesita — el asistente que aprende y el conocimiento que lo guarda — se
   * exigen acá: si alguno está apagado, autorizar sería prometer un botón que
   * no hace nada.
   */
  @Post(':id/historial/autorizar')
  @RequireModule('whatsapp')
  @RequireModule('knowledge')
  @RequirePermission('channels.manage')
  @ApiOperation({ summary: 'Autoriza leer los últimos 50 chats del número para aprender de ellos' })
  async autorizarHistorial(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    try {
      return await withTenant(pool(), actor.tenantId, async (c) => {
        const { autorizadoEl } = await autorizarAprendizajeDeChats(c, {
          tenantId: actor.tenantId,
          accountId: id,
          actor: actor.userId,
          actorKind: 'user',
          ...(request.requestId ? { requestId: request.requestId } : {}),
          encolar: ({ autorizadoEl: cuando }) =>
            encolarAprendizaje(actor.tenantId, id, request.requestId, cuando),
        });
        return { autorizado: true, desde: autorizadoEl };
      });
    } catch (err) {
      traducirHistorial(err);
    }
  }

  /** Retira la autorización: el job pendiente termina sin llamar a Zernio. */
  @Post(':id/historial/retirar')
  @RequireModule('whatsapp')
  @RequireModule('knowledge')
  @RequirePermission('channels.manage')
  @ApiOperation({ summary: 'Retira la autorización de leer los chats del número' })
  async retirarHistorial(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    try {
      await withTenant(pool(), actor.tenantId, (c) =>
        retirarAutorizacionDeChats(c, {
          tenantId: actor.tenantId,
          accountId: id,
          actor: actor.userId,
          actorKind: 'user',
          ...(request.requestId ? { requestId: request.requestId } : {}),
        }),
      );
      return { retirado: true };
    } catch (err) {
      traducirHistorial(err);
    }
  }

  /**
   * El estado del historial para la tarjeta de Canales: la marca de la cuenta
   * y lo que Meta dice de verdad (leído de Zernio con la llave del NEGOCIO).
   */
  @Get(':id/historial')
  @RequireModule('whatsapp')
  @RequireModule('knowledge')
  @RequirePermission('channels.manage')
  @ApiOperation({ summary: 'Estado de la lectura de los chats del número' })
  async historial(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    try {
      return await withTenant(pool(), actor.tenantId, (c) =>
        estadoDelHistorial(c, { tenantId: actor.tenantId, accountId: id }),
      );
    } catch (err) {
      traducirHistorial(err);
    }
  }
}
