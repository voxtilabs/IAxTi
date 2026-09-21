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
  DEFINICIONES,
  OBJETIVOS,
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
import { enteroDeEntorno } from '@iaxti/core';
import {
  applyProposal,
  dismissProposal,
  pendingProposal,
  proposeConfiguration,
  evalGate,
  getAgent as getAgentContract,
  harvestFeedbackCases,
  listEvalCases,
  listEvalRuns,
  tasaDeObjetivo,
  runEvaluation,
} from '@iaxti/module-agents';
import { ConflictException } from '@nestjs/common';
import type { AgentInput, AgentTask, Provider } from '@iaxti/module-agents';
import { RequireModule, RequirePermission } from './authz/decorators';
import { actorCan } from './authz/can';
import type { Actor, WithUser } from './authz/authz.guard';
import { apiPool } from './db';
import { registry } from './registry';

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
      return await withTenant(pool(), actor.tenantId, async (c) => {
        // El gate (#53): a una config con score MENOR no se pasa. Solo
        // bloquea cuando hay evaluaciones de ambas versiones.
        const cambiaConfig =
          body.provider !== undefined || body.model !== undefined || body.promptVersion !== undefined;
        if (cambiaConfig) {
          const agente = await getAgentContract(c, actor.tenantId, id);
          const gate = await evalGate(c, actor.tenantId, agente, {
            provider: body.provider ?? agente.provider,
            model: body.model ?? agente.model,
            promptVersion: body.promptVersion ?? agente.promptVersion,
          });
          if (!gate.allowed) {
            throw new ConflictException({
              code: 'EVAL_REGRESSION',
              message: `Esa versión rinde peor en la evaluación (${gate.candidata} vs ${gate.actual}). Mejora el prompt o el dataset antes de cambiar.`,
            });
          }
        }
        return updateAgent(c, {
          ...body,
          tenantId: actor.tenantId,
          agentId: id,
          actor: actor.userId,
          requestId: request.requestId,
        });
      });
    } catch (err) {
      if (err instanceof ConflictException) throw err;
      const message = (err as Error).message;
      if (/No encontramos/.test(message)) throw new NotFoundException({ code: 'AGENT_NOT_FOUND', message });
      throw new BadRequestException({ code: 'AGENT_INVALID', message });
    }
  }

  /**
   * El catálogo de objetivos, para la pantalla que crea el asistente (#385).
   *
   * Va por el servidor y no como constante del frontend por el motivo de
   * siempre en este repo: una copia allá se desincroniza y nadie se entera
   * hasta que alguien elige un objetivo que ya no existe.
   *
   * `disponible` sale de los módulos ACTIVOS para este tenant. Un objetivo
   * que necesita agenda y el tenant no la tiene no se esconde: se muestra
   * bloqueado con el motivo, porque es lo que le dice al negocio qué le
   * falta. Bajar de plan nunca esconde (SPEC §6).
   */
  @Get('objetivos')
  @RequirePermission('agents.configure')
  @ApiOperation({ summary: 'Los objetivos que puede tener un asistente, y cuáles puede usar este negocio' })
  objetivos() {
    const activos = new Set(registry.health().filter((m) => m.active).map((m) => m.id));
    return OBJETIVOS.map((id) => {
      const d = DEFINICIONES[id];
      const faltan = d.requiere.filter((m) => !activos.has(m));
      return {
        id: d.id,
        titulo: d.titulo,
        requiere: d.requiere,
        faltan,
        disponible: faltan.length === 0,
        datosMinimos: d.datosMinimos,
        detallePorDefecto: d.detallePorDefecto,
        // La instrucción NO se expone: es el prompt del sistema. Mostrarla
        // invita a editarla en la pantalla, y entonces deja de ser una
        // decisión del producto para volverse texto suelto por tenant.
        mide: d.eventoDeExito.length > 0,
      };
    });
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
      const usdClp = enteroDeEntorno('USD_CLP_RATE', 950);
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
        activeModules: registry
          .health()
          .filter((m) => m.active)
          .map((m) => m.id),
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

  // --- La evaluación (#53): ninguna versión empeora ---

  @Post(':id/evaluate')
  @RequirePermission('agents.configure')
  @ApiOperation({ summary: 'Corre el dataset del tenant contra la config actual' })
  async evaluate(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      const agente = await getAgent(c, actor.tenantId, id).catch(() => {
        throw new NotFoundException({ code: 'AGENT_NOT_FOUND', message: 'No encontramos ese asistente.' });
      });
      if (!providerAvailable(agente.provider as Provider)) {
        throw new ServiceUnavailableException({
          code: 'PROVIDER_UNAVAILABLE',
          message: 'El proveedor de IA aún no tiene llave configurada en este ambiente.',
        });
      }
      // El feedback fresco de la bandeja entra al dataset antes de correr.
      await harvestFeedbackCases(c, actor.tenantId);
      const cases = await listEvalCases(c, actor.tenantId);
      if (cases.length === 0) {
        throw new BadRequestException({
          code: 'NO_EVAL_CASES',
          message: 'Aún no hay casos: el pulgar arriba/abajo de la bandeja los va creando.',
        });
      }
      try {
        return await runEvaluation(c, {
          tenantId: actor.tenantId,
          agent: agente,
          cases,
          requestId: request.requestId,
        });
      } catch (err) {
        // Ningún caso se pudo medir: el modelo cortó todas las respuestas.
        // No es un score de 0 y no se guarda como tal — decirlo así evita
        // que el dueño lea "tu asistente sacó 0" cuando el problema es el
        // tope de tokens.
        if (/no hay medición/.test((err as Error).message)) {
          throw new ServiceUnavailableException({
            code: 'EVAL_NOT_MEASURABLE',
            message:
              'No pudimos evaluar: el modelo cortó todas las respuestas por falta de espacio. ' +
              'Prueba con casos de contexto más corto, o con un modelo que razone menos.',
          });
        }
        throw err;
      }
    });
  }

  @Get(':id/objetivo')
  @RequirePermission('agents.usage.read')
  @ApiOperation({ summary: 'Si el asistente está logrando su objetivo, y cuánto de eso es mérito suyo' })
  async objetivo(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) => tasaDeObjetivo(c, actor.tenantId, id));
  }

  @Get(':id/evals')
  @RequirePermission('agents.usage.read')
  @ApiOperation({ summary: 'Las corridas de evaluación del asistente' })
  async evals(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) => listEvalRuns(c, actor.tenantId, id));
  }

  // --- El configurador (#50): propone un diff, el usuario decide ---

  @Get('configurador')
  @RequirePermission('agents.configure')
  @ApiOperation({ summary: 'La propuesta pendiente del configurador (si hay)' })
  async configuradorPendiente(@Req() request: WithUser) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) => pendingProposal(c, actor.tenantId));
  }

  @Post('configurador')
  @RequirePermission('agents.configure')
  @ApiOperation({ summary: 'Arma la propuesta del CRM a partir de la descripción del negocio' })
  async configuradorProponer(
    @Req() request: WithUser,
    @Body() body: { description?: string; vertical?: string },
  ) {
    const actor = actorOf(request);
    if (!body?.description?.trim()) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Cuéntanos primero de qué se trata el negocio.',
        details: [{ field: 'description' }],
      });
    }
    return withTenant(pool(), actor.tenantId, async (c) => {
      const agentes = await listAgents(c, actor.tenantId);
      const agente = agentes.find((a) => a.active);
      if (agente && !providerAvailable(agente.provider as Provider)) {
        throw new ServiceUnavailableException({
          code: 'PROVIDER_UNAVAILABLE',
          message:
            'El proveedor de IA de este asistente aún no tiene llave configurada en este ambiente.',
        });
      }
      const res = await proposeConfiguration(c, {
        activeModules: registry
          .health()
          .filter((m) => m.active)
          .map((m) => m.id),
        tenantId: actor.tenantId,
        description: body.description!,
        vertical: body.vertical,
        actorUserId: actor.userId,
        requestId: request.requestId,
      });
      if (res.status === 'failed') {
        throw new BadRequestException({ code: 'CONFIGURATOR_FAILED', message: res.error });
      }
      return res.proposal;
    });
  }

  @Post('configurador/:pid/aplicar')
  @RequirePermission('agents.configure')
  @ApiOperation({ summary: 'Aplica el diff con los permisos del usuario (user via agent)' })
  async configuradorAplicar(@Req() request: WithUser, @Param('pid') pid: string) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      try {
        return await applyProposal(c, {
          tenantId: actor.tenantId,
          proposalId: pid,
          actorUserId: actor.userId,
          requestId: request.requestId,
        });
      } catch (err) {
        throw new BadRequestException({ code: 'PROPOSAL_GONE', message: (err as Error).message });
      }
    });
  }

  @Post('configurador/:pid/descartar')
  @RequirePermission('agents.configure')
  @ApiOperation({ summary: 'Descarta la propuesta' })
  async configuradorDescartar(@Req() request: WithUser, @Param('pid') pid: string) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      try {
        await dismissProposal(c, { tenantId: actor.tenantId, proposalId: pid, actorUserId: actor.userId });
        return { dismissed: true };
      } catch (err) {
        throw new BadRequestException({ code: 'PROPOSAL_GONE', message: (err as Error).message });
      }
    });
  }
}
