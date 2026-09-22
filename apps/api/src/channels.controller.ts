import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { withTenant } from '@iaxti/db';
import { diagnosticarCanal, findAccountById, listChannelAccounts } from '@iaxti/module-channels';
import { listTemplates, listWhatsAppNumbers, resumeBusinessSends } from '@iaxti/module-whatsapp';
import { createWidget, listWidgets, setWidgetActive } from '@iaxti/module-webchat';
import { RequireModule, RequirePermission } from './authz/decorators';
import type { Actor, WithUser } from './authz/authz.guard';
import { apiPool } from './db';

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

/** La pantalla de canales (#45): estado, calidad y la reactivación manual. */
@ApiTags('channels')
@Controller()
@RequireModule('channels')
export class ChannelsController {
  @Get('channels')
  // Mirar el estado de un número —calidad, pausa— es leer; configurarlo es
  // otra cosa. El permiso existía en el catálogo sin que ninguna ruta lo
  // usara. Hoy no cambia quién entra (ADMIN tiene ambos), pero deja la
  // puerta lista para dárselo a SUPERVISOR cuando se decida.
  @RequirePermission('channels.read')
  @ApiOperation({ summary: 'Cuentas de canal con sus números y calidad' })
  async list(@Req() request: WithUser) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      const [accounts, numbers] = await Promise.all([
        listChannelAccounts(c, actor.tenantId),
        listWhatsAppNumbers(c, actor.tenantId).catch(() => []),
      ]);
      return accounts.map((a) => ({
        ...a,
        numbers: numbers.filter((n) => n.channelAccountId === a.id),
      }));
    });
  }

  /**
   * Por qué no llegan los mensajes (#434).
   *
   * Cuatro causas que se arreglan en lugares distintos y que desde adentro
   * se veían todas iguales. Esto las separa y dice qué hacer con cada una,
   * sin entrar a ninguna consola — que es lo que no se podía hacer: la API
   * de Dokploy no expone logs de contenedor.
   */
  @Get('channels/:id/diagnostico')
  @RequirePermission('channels.read')
  @ApiOperation({ summary: 'Por qué este canal no está recibiendo, paso a paso' })
  async diagnostico(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      const cuenta = await findAccountById(c, id);
      if (!cuenta || cuenta.tenantId !== actor.tenantId) {
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'No encontramos ese canal.' });
      }
      const esWhatsApp = cuenta.kind === 'whatsapp';
      return diagnosticarCanal(
        c,
        { tenantId: actor.tenantId, accountId: id },
        {
          // Solo se mira si la variable EXISTE. El valor no sale de acá ni
          // en el diagnóstico ni en los logs.
          hayCredencial: (ref) => Boolean(ref && process.env[ref]),
          ...(esWhatsApp
            ? {
                numeroConectado: async () =>
                  (await listWhatsAppNumbers(c, actor.tenantId)).some(
                    (n) => n.channelAccountId === id && n.connectedAt !== null,
                  ),
                plantillasAprobadas: async () =>
                  (await listTemplates(c, actor.tenantId)).filter((p) => p.status === 'approved').length,
              }
            : {}),
          entrantesRecientes: async () => {
            const r = await c.query(
              `SELECT count(*)::int AS n FROM messages m
                 JOIN conversations v ON v.id = m.conversation_id AND v.tenant_id = m.tenant_id
                WHERE m.tenant_id = $1 AND v.channel_account_id = $2
                  AND m.direction = 'in' AND m.created_at > now() - interval '24 hours'`,
              [actor.tenantId, id],
            );
            return Number(r.rows[0]?.n ?? 0);
          },
        },
      );
    });
  }

  @Post('whatsapp/numbers/:id/resume')
  @RequirePermission('channels.manage')
  @ApiOperation({ summary: 'Reactiva los envíos del negocio tras una pausa por calidad' })
  async resume(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    try {
      await withTenant(pool(), actor.tenantId, (c) =>
        resumeBusinessSends(c, { tenantId: actor.tenantId, numberId: id, requestId: request.requestId }),
      );
    } catch (err) {
      throw new BadRequestException({ code: 'RESUME_REJECTED', message: (err as Error).message });
    }
    return { resumed: true };
  }
}

/** Administración del webchat (#46): widgets y su snippet. */
@ApiTags('channels')
@Controller('webchat/widgets')
@RequireModule('webchat')
export class WebchatAdminController {
  @Get()
  @RequirePermission('webchat.manage')
  @ApiOperation({ summary: 'Widgets del webchat' })
  async list(@Req() request: WithUser) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) => listWidgets(c, actor.tenantId));
  }

  @Post()
  @RequirePermission('webchat.manage')
  @ApiOperation({ summary: 'Crea un widget para un dominio' })
  async create(
    @Req() request: WithUser,
    @Body() body: { allowedDomain?: string; name?: string; welcomeMessage?: string },
  ) {
    const actor = actorOf(request);
    if (!body?.allowedDomain?.trim()) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Dinos el dominio del sitio donde vivirá el chat.',
        details: [{ field: 'allowedDomain' }],
      });
    }
    return withTenant(pool(), actor.tenantId, (c) =>
      createWidget(c, {
        tenantId: actor.tenantId,
        allowedDomain: body.allowedDomain!,
        name: body.name,
        welcomeMessage: body.welcomeMessage,
      }),
    );
  }

  @Post(':id/toggle')
  @RequirePermission('webchat.manage')
  @ApiOperation({ summary: 'Activa o desactiva el widget (el historial queda)' })
  async toggle(@Req() request: WithUser, @Param('id') id: string, @Body() body: { active?: boolean }) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) =>
      setWidgetActive(c, { tenantId: actor.tenantId, widgetId: id, active: Boolean(body?.active) }),
    );
  }
}
