import {
  BadRequestException,
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
  @RequirePermission('channels.manage')
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
