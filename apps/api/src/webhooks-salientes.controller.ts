import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { withTenant } from '@iaxti/db';
import {
  createEndpoint,
  deleteEndpoint,
  listDeliveries,
  listEndpoints,
  retryDelivery,
  rotateSecret,
  setEndpointActive,
} from '@iaxti/module-integrations';
import { RequireModule, RequirePermission } from './authz/decorators';
import type { Actor, WithUser } from './authz/authz.guard';
import { apiPool } from './db';
import { registry } from './registry';

// Webhooks salientes (#76): la otra mitad de la integración. El secreto
// de firma se ve al crear y al rotar; el panel muestra cada entrega con
// su respuesta y permite reintentar a mano.

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

function actorOf(request: WithUser): Actor {
  return request.actor as Actor;
}

@ApiTags('webhooks')
@Controller('webhooks-salientes')
@RequireModule('integrations')
export class WebhooksSalientesController {
  @Get()
  @RequirePermission('webhooks.manage')
  @ApiOperation({ summary: 'Los webhooks del tenant (con su secreto de firma)' })
  async list(@Req() request: WithUser) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) => listEndpoints(c, actor.tenantId));
  }

  @Get('eventos')
  @RequirePermission('webhooks.manage')
  @ApiOperation({ summary: 'El catálogo de eventos suscribibles' })
  eventos() {
    return registry.eventsCatalog();
  }

  @Post()
  @RequirePermission('webhooks.manage')
  @ApiOperation({ summary: 'Crea el webhook — guarda el secreto para verificar la firma' })
  async create(@Req() request: WithUser, @Body() body: { url?: string; events?: string[] }) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      try {
        return await createEndpoint(c, {
          tenantId: actor.tenantId,
          url: body?.url ?? '',
          events: body?.events ?? [],
          catalog: new Set(registry.eventsCatalog()),
          actor: actor.userId,
          requestId: request.requestId,
        });
      } catch (err) {
        throw new BadRequestException({ code: 'WEBHOOK_INVALID', message: (err as Error).message });
      }
    });
  }

  @Post(':id/rotate')
  @RequirePermission('webhooks.manage')
  @ApiOperation({ summary: 'Rota el secreto de firma (el anterior muere al instante)' })
  async rotate(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      try {
        return await rotateSecret(c, {
          tenantId: actor.tenantId,
          endpointId: id,
          actor: actor.userId,
          requestId: request.requestId,
        });
      } catch (err) {
        throw new BadRequestException({ code: 'WEBHOOK_INVALID', message: (err as Error).message });
      }
    });
  }

  @Post(':id/active')
  @RequirePermission('webhooks.manage')
  @ApiOperation({ summary: 'Enciende o apaga el webhook (y limpia la falla sostenida)' })
  async active(@Req() request: WithUser, @Param('id') id: string, @Body() body: { active?: boolean }) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      try {
        return await setEndpointActive(c, {
          tenantId: actor.tenantId,
          endpointId: id,
          active: body?.active === true,
          actor: actor.userId,
        });
      } catch (err) {
        throw new BadRequestException({ code: 'WEBHOOK_INVALID', message: (err as Error).message });
      }
    });
  }

  @Delete(':id')
  @RequirePermission('webhooks.manage')
  @ApiOperation({ summary: 'Elimina el webhook y su historial' })
  async remove(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      try {
        await deleteEndpoint(c, { tenantId: actor.tenantId, endpointId: id, actor: actor.userId });
        return { deleted: true };
      } catch (err) {
        throw new BadRequestException({ code: 'WEBHOOK_INVALID', message: (err as Error).message });
      }
    });
  }

  @Get('entregas')
  @RequirePermission('webhooks.manage')
  @ApiOperation({ summary: 'El panel de entregas: payload, respuesta y estado' })
  async deliveries(@Req() request: WithUser, @Query('endpointId') endpointId?: string) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) =>
      listDeliveries(c, actor.tenantId, endpointId),
    );
  }

  @Post('entregas/:id/retry')
  @RequirePermission('webhooks.manage')
  @ApiOperation({ summary: 'Reintenta una entrega fallida, a mano' })
  async retry(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      try {
        await retryDelivery(c, { tenantId: actor.tenantId, deliveryId: id });
        return { queued: true };
      } catch (err) {
        throw new BadRequestException({ code: 'WEBHOOK_INVALID', message: (err as Error).message });
      }
    });
  }
}
