import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { withTenant } from '@iaxti/db';
import { listChannelAccounts } from '@iaxti/module-channels';
import { listWhatsAppNumbers, resumeBusinessSends } from '@iaxti/module-whatsapp';
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
