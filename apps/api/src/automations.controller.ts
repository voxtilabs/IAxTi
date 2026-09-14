import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { withTenant } from '@iaxti/db';
import {
  createRule,
  deleteRule,
  getRule,
  listRules,
  listRuns,
  previewRule,
  seedTemplates,
  setRuleActive,
  ACTION_REQUIREMENTS,
  type Action,
  type Condition,
  type Trigger,
} from '@iaxti/module-automations';
import { RequireModule, RequirePermission } from './authz/decorators';
import type { Actor, WithUser } from './authz/authz.guard';
import { apiPool } from './db';
import { registry } from './registry';

// automations (#62, SPEC §15): que el seguimiento que hoy no se hace, se
// haga — reglas declarativas, vista previa antes de activar, y el motor
// con las mismas leyes del humano (consentimiento y silencio).

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

function activeModules(): string[] {
  return Object.keys(ACTION_REQUIREMENTS)
    .map((k) => ACTION_REQUIREMENTS[k as keyof typeof ACTION_REQUIREMENTS])
    .filter((m, i, arr) => arr.indexOf(m) === i)
    .filter((m) => registry.isActive(m));
}

@ApiTags('automations')
@Controller('automations')
@RequireModule('automations')
export class AutomationsController {
  @Get()
  @RequirePermission('automations.read')
  @ApiOperation({ summary: 'Las reglas del tenant' })
  async list(@Req() request: WithUser) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) => listRules(c, actor.tenantId));
  }

  @Post()
  @RequirePermission('automations.manage')
  @ApiOperation({ summary: 'Crea una regla (nace apagada: primero la vista previa)' })
  async create(
    @Req() request: WithUser,
    @Body() body: { name?: string; trigger?: Trigger; conditions?: Condition[]; actions?: Action[] },
  ) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      try {
        return await createRule(c, {
          tenantId: actor.tenantId,
          name: body.name ?? '',
          trigger: body.trigger as Trigger,
          conditions: body.conditions,
          actions: body.actions ?? [],
          actor: actor.userId,
          requestId: request.requestId,
        });
      } catch (err) {
        throw new BadRequestException({ code: 'RULE_INVALID', message: (err as Error).message });
      }
    });
  }

  @Post('seed')
  @RequirePermission('automations.manage')
  @ApiOperation({ summary: 'Las tres reglas iniciales del rubro, listas para activar' })
  async seed(@Req() request: WithUser, @Body() body: { vertical?: string }) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) =>
      seedTemplates(c, {
        tenantId: actor.tenantId,
        vertical: body?.vertical ?? 'otro',
        actor: actor.userId,
        requestId: request.requestId,
      }),
    );
  }

  @Get('runs')
  @RequirePermission('automations.read')
  @ApiOperation({ summary: 'Las últimas corridas del motor' })
  async runs(@Req() request: WithUser, @Query('ruleId') ruleId?: string) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) => listRuns(c, actor.tenantId, ruleId));
  }

  @Get(':id/preview')
  @RequirePermission('automations.manage')
  @ApiOperation({ summary: '"A quién le aplicaría hoy" — antes de activar' })
  async preview(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      const rule = await getRule(c, actor.tenantId, id).catch(() => {
        throw new NotFoundException({ code: 'RULE_NOT_FOUND', message: 'No encontramos esa regla.' });
      });
      return previewRule(c, actor.tenantId, rule);
    });
  }

  @Post(':id/active')
  @RequirePermission('automations.manage')
  @ApiOperation({ summary: 'Enciende o apaga la regla' })
  async setActive(@Req() request: WithUser, @Param('id') id: string, @Body() body: { active?: boolean }) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      try {
        return await setRuleActive(c, {
          tenantId: actor.tenantId,
          ruleId: id,
          active: body?.active === true,
          activeModules: activeModules(),
          actor: actor.userId,
          requestId: request.requestId,
        });
      } catch (err) {
        throw new BadRequestException({ code: 'RULE_INVALID', message: (err as Error).message });
      }
    });
  }

  @Delete(':id')
  @RequirePermission('automations.manage')
  @ApiOperation({ summary: 'Elimina la regla y su historial' })
  async remove(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      try {
        await deleteRule(c, { tenantId: actor.tenantId, ruleId: id, actor: actor.userId, requestId: request.requestId });
      } catch {
        throw new NotFoundException({ code: 'RULE_NOT_FOUND', message: 'No encontramos esa regla.' });
      }
      return { deleted: true };
    });
  }
}
