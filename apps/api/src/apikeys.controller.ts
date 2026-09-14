import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { withTenant } from '@iaxti/db';
import { createApiKey, listApiKeys, revokeApiKey } from '@iaxti/module-authorization';
import { RequirePermission } from './authz/decorators';
import type { Actor, WithUser } from './authz/authz.guard';
import { apiPool } from './db';
import { registry } from './registry';

// API keys por tenant (#24, SPEC §7/§8): el token se ve UNA vez, el hash
// vive en la base, y los scopes son subconjunto del catálogo — jamás más
// que los permisos del tenant, jamás cross-tenant.

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

@ApiTags('apikeys')
@Controller('apikeys')
export class ApiKeysController {
  @Get()
  @RequirePermission('apikeys.manage')
  @ApiOperation({ summary: 'Las API keys del tenant (sin el token, obvio)' })
  async list(@Req() request: WithUser) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) => listApiKeys(c, actor.tenantId));
  }

  @Get('scopes')
  @RequirePermission('apikeys.manage')
  @ApiOperation({ summary: 'El catálogo de permisos disponibles como scopes' })
  scopes() {
    return [...registry.permissionsCatalog().keys()]
      .filter((p) => !p.startsWith('platform.'))
      .sort();
  }

  @Post()
  @RequirePermission('apikeys.manage')
  @ApiOperation({ summary: 'Crea la key — el token se muestra UNA sola vez' })
  async create(
    @Req() request: WithUser,
    @Body() body: { name?: string; scopes?: string[]; expiresAt?: string },
  ) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      try {
        return await createApiKey(c, {
          tenantId: actor.tenantId,
          name: body?.name ?? '',
          scopes: body?.scopes ?? [],
          catalog: new Set(registry.permissionsCatalog().keys()),
          expiresAt: body?.expiresAt ? new Date(body.expiresAt) : null,
          actor: actor.userId,
          requestId: request.requestId,
        });
      } catch (err) {
        throw new BadRequestException({ code: 'APIKEY_INVALID', message: (err as Error).message });
      }
    });
  }

  @Delete(':id')
  @RequirePermission('apikeys.manage')
  @ApiOperation({ summary: 'Revoca la key — inmediato, sin vuelta atrás' })
  async revoke(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      try {
        await revokeApiKey(c, {
          tenantId: actor.tenantId,
          apiKeyId: id,
          actor: actor.userId,
          requestId: request.requestId,
        });
        return { revoked: true };
      } catch (err) {
        throw new BadRequestException({ code: 'APIKEY_INVALID', message: (err as Error).message });
      }
    });
  }
}
