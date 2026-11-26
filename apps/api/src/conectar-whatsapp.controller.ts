import {
  BadGatewayException,
  ConflictException,
  Controller,
  Get,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { withTenant } from '@iaxti/db';
import {
  ErrorDeZernio,
  ErrorDelAlta,
  baseDeZernio,
  conectarNumeroDesdeLaApp,
  enlaceParaConectarDesdeLaApp,
  numerosParaConectar,
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

@ApiTags('channels')
@Controller('channels/whatsapp')
@RequireModule('channels')
export class ConectarWhatsAppController {
  /** Paso 1: el enlace de Meta, en el perfil de Zernio de este negocio. */
  @Post('enlace')
  @RequireModule('whatsapp')
  @RequirePermission('channels.manage')
  @ApiOperation({ summary: 'Crea el enlace para conectar un número de WhatsApp a este negocio' })
  async enlace(@Req() request: WithUser): Promise<{ url: string }> {
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
}
