import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Put,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { withTenant } from '@iaxti/db';
import { getTenantSettings, updateTenantSettings } from '@iaxti/module-organizations';
import { bandejaSettings } from '@iaxti/module-conversations';
import type { BandejaSettings } from '@iaxti/module-conversations';
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

/**
 * Ajustes de la bandeja (#38): asignación automática, aviso de "new sin
 * dueño" y SLA de primera respuesta. Solo el ADMIN del tenant
 * (`tenant.settings` según la matriz §23). La forma la valida el dominio
 * (`bandejaSettings`): lo que no calza cae al por-defecto de la spec.
 */
@ApiTags('settings')
@Controller('settings')
@RequireModule('conversations')
export class SettingsController {
  @Get('bandeja')
  @RequirePermission('tenant.settings')
  @ApiOperation({ summary: 'Ajustes de asignación y SLA de la bandeja' })
  async get(@Req() request: WithUser): Promise<BandejaSettings> {
    const actor = request.actor as Actor;
    const settings = await withTenant(pool(), actor.tenantId, (c) =>
      getTenantSettings(c, actor.tenantId),
    );
    return bandejaSettings(settings);
  }

  @Put('bandeja')
  @RequirePermission('tenant.settings')
  @ApiOperation({ summary: 'Guarda los ajustes de la bandeja' })
  async put(@Req() request: WithUser, @Body() body: Partial<BandejaSettings>): Promise<BandejaSettings> {
    const actor = request.actor as Actor;
    if (!body || typeof body !== 'object') {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'No llegó ningún ajuste para guardar.',
      });
    }
    return withTenant(pool(), actor.tenantId, async (c) => {
      const actuales = bandejaSettings(await getTenantSettings(c, actor.tenantId));
      // Normaliza contra el dominio: valores fuera de rango caen al defecto.
      const limpios = bandejaSettings({ bandeja: { ...actuales, ...body } });
      await updateTenantSettings(c, actor.tenantId, { bandeja: limpios });
      return limpios;
    });
  }
}
