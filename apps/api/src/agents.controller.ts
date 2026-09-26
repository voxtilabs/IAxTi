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
  herramientasExpuestas,
  iaSettings,
  listAgents,
  listExecutions,
  motivoDelProveedor,
  providerAvailable,
  resolverObjetivo,
  runAgentTask,
  updateAgent,
} from '@iaxti/module-agents';
import { getTenantSettings } from '@iaxti/module-organizations';
import { catalogoDeMetricas, metricaEnRango } from '@iaxti/module-analytics';
import { enteroDeEntorno } from '@iaxti/core';
import { z } from 'zod';
import {
  agenteQueConfigura,
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
import type { AgentInput, Provider } from '@iaxti/module-agents';
import { RequireModule, RequirePermission } from './authz/decorators';
import { Cuerpo, textoRequerido } from './validar';
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
/**
 * El fallo del proveedor, dicho como corresponde (#402).
 *
 * Antes todo lo que no fuera "falta la llave" caía en el genérico "algo
 * falló de nuestro lado" — que además miente sobre de qué lado está el
 * problema cuando lo que pasa es que el cliente se quedó sin saldo.
 *
 * `503` cuando reintentar tiene sentido y `409` cuando no: un 503 le dice
 * al cliente HTTP "vuelve a intentar", y con saldo cero eso es hacerle
 * perder el tiempo.
 */
function comoExcepcionDelProveedor(error: unknown): never {
  const d = motivoDelProveedor(error);
  const cuerpo = { code: `PROVIDER_${d.motivo.toUpperCase()}`, message: d.message };
  if (d.reintentable) throw new ServiceUnavailableException(cuerpo);
  throw new ConflictException(cuerpo);
}

/**
 * Los esquemas de entrada (#524), al lado de sus rutas.
 *
 * El mensaje va escrito acá porque lo lee quien está usando el asistente
 * —muchas veces con un cliente esperando— y no quien programa.
 *
 * Y el orden de las claves no es decorativo: zod informa los problemas en ese
 * orden y el puente usa el mensaje del PRIMERO, así que `task` va antes que
 * `prompt` — igual que los dos `if` que esto reemplazó, donde la tarea
 * inválida ganaba al texto que faltaba.
 */
const TareaDelAsistente = z.object({
  // El enum sale de la MISMA lista que usa el runtime: una tarea nueva en
  // `TASKS` queda aceptada acá sin tocar esta ruta, y el mensaje se arma con
  // esa lista como antes.
  task: z.enum(TASKS, { error: `La tarea es una de: ${TASKS.join(', ')}.` }),
  prompt: textoRequerido('Falta el texto de entrada.'),
  context: z.string().optional(),
});

const PreguntaAlAsistente = z.object({
  pregunta: textoRequerido('Falta la pregunta.'),
});

const DescripcionDelNegocio = z.object({
  description: textoRequerido('Cuéntanos primero de qué se trata el negocio.'),
  vertical: z.string().optional(),
});

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
        // Con quién habla (#410). La pantalla agrupa por esto: "Vender" y
        // "Responder sobre los números" no son comparables y ofrecerlos en
        // la misma lista haría elegir mal.
        destinatario: d.destinatario,
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
    @Cuerpo(TareaDelAsistente) body: z.infer<typeof TareaDelAsistente>,
  ) {
    const actor = actorOf(request);
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
        task: body.task,
        prompt: body.prompt,
        context: body.context,
        requestId: request.requestId,
        actorUserId: actor.userId,
        activeModules: registry
          .health()
          .filter((m) => m.active)
          .map((m) => m.id),
      });
      if (res.status === 'failed') {
        // `runAgentTask` no lanza: devuelve el texto crudo de quien falló.
        // Si ese texto es del proveedor, se traduce (#402) — llega en inglés
        // y con una URL de su panel, que no es un mensaje para el dueño de
        // una pyme. Si NO lo reconocemos como del proveedor, se respeta el
        // original: puede venir de una tool y perderlo sería peor.
        const d = motivoDelProveedor(res.error);
        if (d.motivo !== 'desconocido') {
          const cuerpo = { code: `PROVIDER_${d.motivo.toUpperCase()}`, message: d.message };
          if (d.reintentable) throw new ServiceUnavailableException(cuerpo);
          throw new ConflictException(cuerpo);
        }
        throw new BadRequestException({
          code: 'AGENT_RUN_FAILED',
          message: res.error ?? 'El asistente no pudo completar la tarea.',
        });
      }
      return res;
    });
  }

  /**
   * El dueño le pregunta por sus números (#410).
   *
   * Es OTRA puerta que `:id/run`, no un parámetro más, por tres razones que
   * no se pueden cumplir en la de allá:
   *
   *  1. Acá las herramientas SE EJECUTAN. `run` corre una sola pasada sin
   *     tools; el asistente de números sin tools no responde nada — inventa.
   *  2. La identidad que ejecuta es la de QUIEN PREGUNTA, no la del dueño de
   *     una conversación. Un vendedor que pregunta "cómo vamos" ve lo suyo,
   *     igual que en el tablero, porque el permiso lo resuelve la misma
   *     función (ADR-0008).
   *  3. Solo se ofrecen las herramientas del OBJETIVO, ni una más. Aunque el
   *     agente tuviera `crm.create_deal` habilitado de antes, por esta
   *     puerta no aparece: es un asistente que lee, y nada de lo que se
   *     escriba acá tendría a quién avisarle.
   */
  @Post(':id/preguntar')
  @RequirePermission('agents.use')
  @ApiOperation({ summary: 'Le pregunta al asistente del dueño (ejecuta herramientas de lectura)' })
  async preguntar(
    @Req() request: WithUser,
    @Param('id') id: string,
    @Cuerpo(PreguntaAlAsistente) body: z.infer<typeof PreguntaAlAsistente>,
  ) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      const agent = await getAgent(c, actor.tenantId, id).catch(() => {
        throw new NotFoundException({ code: 'AGENT_NOT_FOUND', message: 'No encontramos ese asistente.' });
      });
      const definicion = agent.objetivo ? DEFINICIONES[agent.objetivo] : undefined;
      if (definicion?.destinatario !== 'dueño') {
        throw new BadRequestException({
          code: 'AGENT_NO_ES_DEL_DUENO',
          message:
            'Este asistente está hecho para contestarle a tus clientes, no a ti. ' +
            'Crea uno de "Responder sobre los números" para preguntarle acá.',
        });
      }
      // El de configuración también es del dueño, pero su salida NO es una
      // respuesta: es una propuesta que se aplica o se descarta (#415). Una
      // respuesta suelta por acá sonaría a que algo quedó configurado.
      //
      // Va ANTES de mirar el proveedor a propósito: que este asistente no
      // conteste por esta puerta es lo que ES, no depende de si hay llave.
      // Un 503 acá mandaría a buscar una llave para una puerta que igual no
      // era la correcta.
      if (definicion.tools.length === 0) {
        throw new BadRequestException({
          code: 'AGENT_PROPONE_NO_RESPONDE',
          message:
            'Este asistente no responde preguntas: propone cómo configurar tu negocio, y tú ' +
            'decides si lo aplicas. Cuéntale de qué se trata en Ajustes → IA.',
        });
      }
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

      const activos = registry
        .health()
        .filter((m) => m.active)
        .map((m) => m.id);
      const objetivo = resolverObjetivo(agent.objetivo!, agent.objetivoDetalle, activos);
      if (!objetivo.alcanzable) {
        throw new BadRequestException({
          code: 'OBJETIVO_INALCANZABLE',
          message: `Para responder sobre los números falta ${objetivo.faltan.join(', ')} en este negocio.`,
        });
      }

      const tools = herramientasExpuestas(
        c,
        {
          tenantId: actor.tenantId,
          // Solo las del objetivo (ver el punto 3 de arriba).
          habilitadas: objetivo.tools,
          actorUserId: actor.userId ?? null,
          agentId: agent.id,
          requestId: request.requestId,
        },
        {
          // El MISMO traductor de permisos que el guard: lo que esta persona
          // no puede ver en el tablero, tampoco se lo cuenta la IA.
          actorPuede: (permiso) => actorCan(actor, permiso),
          habilitadas: objetivo.tools,
          // Las del cliente no se usan por esta puerta: no hay conversación,
          // no hay a quién responderle. Si alguna se pidiera igual, esto es
          // lo que el modelo recibe — un motivo, no una excepción.
          getContext: async () => {
            throw new Error('Acá no hay una conversación abierta.');
          },
          buscarConocimiento: async () => {
            throw new Error('Esta herramienta es para atender clientes.');
          },
          buscarProducto: async () => {
            throw new Error('Esta herramienta es para atender clientes.');
          },
          catalogoDeMetricas: async () => catalogoDeMetricas(),
          metricaDelNegocio: (i) => metricaEnRango(c, { tenantId: actor.tenantId, ...i }),
        },
      );

      const res = await runAgentTask(c, {
        tenantId: actor.tenantId,
        agent,
        task: 'analizar',
        // Llega sin espacios de sobra: el `.trim()` es parte del esquema.
        prompt: body.pregunta,
        tools,
        requestId: request.requestId,
        actorUserId: actor.userId,
        activeModules: activos,
      });
      if (res.status === 'failed') {
        throw new BadRequestException({
          code: 'AGENT_RUN_FAILED',
          message: res.error ?? 'El asistente no pudo responder.',
        });
      }
      return {
        texto: res.text,
        herramientasUsadas: res.herramientasUsadas ?? [],
        truncada: res.truncada === true,
        executionId: res.executionId,
      };
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
        // Sin saldo, cuota agotada o llave vencida: se dice con nombre
        // (#402) en vez de caer en el genérico.
        if (motivoDelProveedor(err).motivo !== 'desconocido') comoExcepcionDelProveedor(err);
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

  /**
   * Quién va a armar la propuesta (#415).
   *
   * La pantalla lo muestra antes de que el dueño escriba nada. Antes de
   * esto, el configurador usaba "el asistente activo" sin decirlo: si el
   * negocio tenía uno de ventas con un modelo barato, la propuesta salía
   * con ese y no había forma de saberlo desde afuera.
   */
  @Get('configurador/quien')
  @RequirePermission('agents.configure')
  @ApiOperation({ summary: 'Qué asistente arma la propuesta de configuración' })
  async configuradorQuien(@Req() request: WithUser) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      const agente = await agenteQueConfigura(c, actor.tenantId);
      if (!agente) return { agente: null, propio: false };
      return {
        agente: { id: agente.id, name: agente.name, model: agente.model },
        // true si es uno hecho PARA esto, false si está prestado del que
        // atiende clientes.
        propio: agente.objetivo === 'configuracion',
      };
    });
  }

  @Post('configurador')
  @RequirePermission('agents.configure')
  @ApiOperation({ summary: 'Arma la propuesta del CRM a partir de la descripción del negocio' })
  async configuradorProponer(
    @Req() request: WithUser,
    @Cuerpo(DescripcionDelNegocio) body: z.infer<typeof DescripcionDelNegocio>,
  ) {
    const actor = actorOf(request);
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
        description: body.description,
        vertical: body.vertical,
        actorUserId: actor.userId,
        requestId: request.requestId,
      });
      if (res.status === 'failed') {
        // Mismo criterio que la corrida (#402): si el fallo es del
        // proveedor se dice con nombre; si no, se respeta el original.
        if (motivoDelProveedor(res.error).motivo !== 'desconocido') comoExcepcionDelProveedor(res.error);
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
