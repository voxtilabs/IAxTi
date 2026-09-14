import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { withTenant } from '@iaxti/db';
import {
  TASKS,
  costPerDay,
  costThisCycle,
  createAgent,
  getAgent,
  getQuota,
  iaSettings,
  listAgents,
  listExecutions,
  providerAvailable,
  runAgentTask,
  updateAgent,
} from '@iaxti/module-agents';
import { getTenantSettings } from '@iaxti/module-organizations';
import type { AgentInput, AgentTask, Provider } from '@iaxti/module-agents';
import { RequireModule, RequirePermission } from './authz/decorators';
import { actorCan } from './authz/can';
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

/** El runtime de agentes (#47): configuración, corridas y consumo. */
@ApiTags('agents')
@Controller('agents')
@RequireModule('agents')
export class AgentsController {
  @Get()
  @RequirePermission('agents.use')
  @ApiOperation({ summary: 'Asistentes del negocio' })
  async list(@Req() request: WithUser) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) => listAgents(c, actor.tenantId));
  }

  @Post()
  @RequirePermission('agents.configure')
  @ApiOperation({ summary: 'Crea un asistente (proveedor y modelo configurables)' })
  async create(@Req() request: WithUser, @Body() body: AgentInput) {
    const actor = actorOf(request);
    try {
      return await withTenant(pool(), actor.tenantId, (c) =>
        createAgent(c, { ...body, tenantId: actor.tenantId, actor: actor.userId, requestId: request.requestId }),
      );
    } catch (err) {
      throw new BadRequestException({ code: 'AGENT_INVALID', message: (err as Error).message });
    }
  }

  @Put(':id')
  @RequirePermission('agents.configure')
  @ApiOperation({ summary: 'Edita el asistente — cambiar de modelo no es deploy' })
  async update(@Req() request: WithUser, @Param('id') id: string, @Body() body: Partial<AgentInput> & { active?: boolean }) {
    const actor = actorOf(request);
    try {
      return await withTenant(pool(), actor.tenantId, (c) =>
        updateAgent(c, {
          ...body,
          tenantId: actor.tenantId,
          agentId: id,
          actor: actor.userId,
          requestId: request.requestId,
        }),
      );
    } catch (err) {
      const message = (err as Error).message;
      if (/No encontramos/.test(message)) throw new NotFoundException({ code: 'AGENT_NOT_FOUND', message });
      throw new BadRequestException({ code: 'AGENT_INVALID', message });
    }
  }

  @Get('usage')
  @RequirePermission('agents.use')
  @ApiOperation({ summary: 'Consumo de IA: asistencias para el equipo, pesos para el dueño' })
  async usage(@Req() request: WithUser) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      const quota = await getQuota(c, actor.tenantId);
      const settings = iaSettings(await getTenantSettings(c, actor.tenantId));
      const base = {
        used: quota.used,
        limit: quota.limit,
        pct: quota.pct,
        exhausted: quota.exhausted,
        economicoConfigurado: settings.economico !== null,
      };
      // El costo en PESOS es para quien supervisa el gasto (matriz §23).
      if (!actorCan(actor, 'agents.usage.read')) return base;
      const costUsd = await costThisCycle(c, actor.tenantId);
      const usdClp = Number(process.env.USD_CLP_RATE ?? 950);
      return {
        ...base,
        costUsdMonth: Number(costUsd.toFixed(4)),
        costClpMonth: Math.round(costUsd * usdClp),
        usdClpRate: usdClp,
        porDia: await costPerDay(c, actor.tenantId, 7),
      };
    });
  }

  @Get('executions')
  @RequirePermission('agents.usage.read')
  @ApiOperation({ summary: 'Corridas con tokens, costo, latencia y trace' })
  async executions(@Req() request: WithUser) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) => listExecutions(c, actor.tenantId));
  }

  @Post(':id/run')
  @RequirePermission('agents.use')
  @ApiOperation({ summary: 'Corre una tarea del asistente (mismo trace que el request)' })
  async run(
    @Req() request: WithUser,
    @Param('id') id: string,
    @Body() body: { task?: string; prompt?: string; context?: string },
  ) {
    const actor = actorOf(request);
    if (!TASKS.includes(body?.task as AgentTask)) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: `La tarea es una de: ${TASKS.join(', ')}.`,
        details: [{ field: 'task' }],
      });
    }
    if (!body?.prompt?.trim()) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Falta el texto de entrada.',
        details: [{ field: 'prompt' }],
      });
    }
    return withTenant(pool(), actor.tenantId, async (c) => {
      const agent = await getAgent(c, actor.tenantId, id).catch(() => {
        throw new NotFoundException({ code: 'AGENT_NOT_FOUND', message: 'No encontramos ese asistente.' });
      });
      if (!agent.active) {
        throw new BadRequestException({ code: 'AGENT_OFF', message: 'Este asistente está apagado.' });
      }
      if (!providerAvailable(agent.provider as Provider)) {
        throw new ServiceUnavailableException({
          code: 'PROVIDER_UNAVAILABLE',
          message:
            'El proveedor de IA de este asistente aún no tiene llave configurada en este ambiente.',
        });
      }
      const res = await runAgentTask(c, {
        tenantId: actor.tenantId,
        agent,
        task: body.task as AgentTask,
        prompt: body.prompt!,
        context: body.context,
        requestId: request.requestId,
        actorUserId: actor.userId,
      });
      if (res.status === 'failed') {
        throw new BadRequestException({
          code: 'AGENT_RUN_FAILED',
          message: res.error ?? 'El asistente no pudo completar la tarea.',
        });
      }
      return res;
    });
  }
}
