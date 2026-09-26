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
  createSequence,
  listSequences,
  enroll,
  enrollmentsForContact,
  stopEnrollment,
  ACTION_REQUIREMENTS,
  type Action,
  type Condition,
  type SequenceStep,
  type Trigger,
} from '@iaxti/module-automations';
import { z } from 'zod';
import { RequireModule, RequirePermission } from './authz/decorators';
import { Cuerpo, textoRequerido } from './validar';
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

/**
 * El cuerpo de POST /automations/sequences/:sid/enroll (#524).
 *
 * Es el único VALIDATION_ERROR de este controlador. Las otras rutas le pasan
 * el cuerpo al módulo, que lo revisa y responde con su propio código
 * (RULE_INVALID, SEQUENCE_INVALID, ENROLL_INVALID): ponerles un esquema con
 * restricciones volvería esos códigos VALIDATION_ERROR, y eso es mover el
 * contrato para ahorrar líneas.
 *
 * El mensaje va copiado tal cual estaba en el `if` que reemplaza: lo lee
 * alguien que está atendiendo a un cliente, no quien programa.
 */
const NuevaInscripcion = z.object({
  // Texto y no uuid a propósito: un id con forma rara hoy llega a `enroll` y
  // vuelve como ENROLL_INVALID. Exigirle uuid acá lo convertiría en
  // VALIDATION_ERROR.
  conversationId: textoRequerido('Falta la conversación.'),
  dealId: z.string().optional(),
});

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

  // --- Secuencias (#63): el seguimiento multi-paso que se corta solo ---

  @Get('sequences')
  @RequirePermission('automations.enroll')
  @ApiOperation({ summary: 'Las secuencias disponibles (para iniciar seguimiento)' })
  async sequences(@Req() request: WithUser) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) => listSequences(c, actor.tenantId));
  }

  @Post('sequences')
  @RequirePermission('automations.manage')
  @ApiOperation({ summary: 'Crea una secuencia (pasos con esperas y condición)' })
  async createSeq(
    @Req() request: WithUser,
    @Body() body: { name?: string; steps?: SequenceStep[] },
  ) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      try {
        return await createSequence(c, {
          tenantId: actor.tenantId,
          name: body.name ?? '',
          steps: body.steps ?? [],
          actor: actor.userId,
          requestId: request.requestId,
        });
      } catch (err) {
        throw new BadRequestException({ code: 'SEQUENCE_INVALID', message: (err as Error).message });
      }
    });
  }

  @Get('sequences/enrollments')
  @RequirePermission('automations.enroll')
  @ApiOperation({ summary: 'El estado de las secuencias de un contacto (ficha)' })
  async enrollments(@Req() request: WithUser, @Query('contactId') contactId?: string) {
    const actor = actorOf(request);
    if (!contactId) return [];
    return withTenant(pool(), actor.tenantId, (c) =>
      enrollmentsForContact(c, actor.tenantId, contactId),
    );
  }

  @Post('sequences/:sid/enroll')
  @RequirePermission('automations.enroll')
  @ApiOperation({ summary: 'Mete la conversación a la secuencia' })
  async enrollConv(
    @Req() request: WithUser,
    @Param('sid') sid: string,
    @Cuerpo(NuevaInscripcion) body: z.infer<typeof NuevaInscripcion>,
  ) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      try {
        return await enroll(c, {
          tenantId: actor.tenantId,
          sequenceId: sid,
          conversationId: body.conversationId,
          dealId: body.dealId,
          actor: actor.userId,
          requestId: request.requestId,
        });
      } catch (err) {
        throw new BadRequestException({ code: 'ENROLL_INVALID', message: (err as Error).message });
      }
    });
  }

  @Post('sequences/enrollments/:eid/stop')
  @RequirePermission('automations.enroll')
  @ApiOperation({ summary: 'Detiene la secuencia para esa conversación' })
  async stopSeq(@Req() request: WithUser, @Param('eid') eid: string) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      try {
        await stopEnrollment(c, { tenantId: actor.tenantId, enrollmentId: eid, actor: actor.userId });
        return { stopped: true };
      } catch (err) {
        throw new BadRequestException({ code: 'ENROLL_INVALID', message: (err as Error).message });
      }
    });
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
