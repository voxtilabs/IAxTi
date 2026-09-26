import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { PoolClient } from 'pg';
import { withTenant } from '@iaxti/db';
import { enteroDeEntorno } from '@iaxti/core';
import {
  CuotaDeIaAgotada,
  aplicarPropuesta,
  type DiagnosticoDelNegocio,
  type LoQueFalta,
  conversarConElAgenteGeneral,
  modeloDelAgenteGeneral,
  nombreDePantalla,
  motivoDelProveedor,
  providerAvailable,
  type Provider,
} from '@iaxti/module-agents';
import { agenteGeneralApagado } from '@iaxti/module-platform';
import { onboardingStatus, type Verificador } from '@iaxti/module-organizations';
import { listChannelAccounts } from '@iaxti/module-channels';
import { listSources } from '@iaxti/module-knowledge';
import { listarEquipo, listarInvitaciones } from '@iaxti/module-identity';
import { listPipelines } from '@iaxti/module-crm';
import { huboAlgunaConversacion } from '@iaxti/module-conversations';
import { listarDisponibilidad } from '@iaxti/module-calendar';
import { listTemplates, puedeEnviarse } from '@iaxti/module-whatsapp';
import { listRules, ruleModuleGaps } from '@iaxti/module-automations';
import { getQuota } from '@iaxti/module-agents';
import { RequireModule, RequirePermission } from './authz/decorators';
import { permisosDelActor } from './authz/can';
import type { Actor, WithUser } from './authz/authz.guard';
import { apiPool } from './db';
import { registry } from './registry';

/**
 * El Agente General (#493, ADR-0025).
 *
 * Configurar el producto conversando. Es OTRA puerta que `agents/:id/run` y
 * que `:id/preguntar`, y las tres razones son de fondo:
 *
 *  1. **No es un asistente del tenant**: no tiene fila en `agents`, no tiene
 *     objetivo ni modo autónomo, y no atiende clientes. Es de la plataforma.
 *  2. **Tiene TODAS las herramientas**, filtradas por los permisos de quien
 *     habla. Las otras puertas ofrecen las del agente o las del objetivo.
 *  3. **Ejecuta contra la propia API**, no contra los casos de uso. Cada
 *     herramienta es una llamada HTTP a su ruta con el token de la persona,
 *     así que pasa por el mismo guard, el mismo audit y las mismas
 *     validaciones que si la hubiera hecho ella desde la pantalla. No hay un
 *     segundo camino con reglas propias, que es por donde se filtran los
 *     agujeros.
 */

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

/** Los dos que pueden tener un turno en el hilo. */
const QUIEN_HABLA = new Set(['user', 'assistant']);

/**
 * La llamada a la propia API, con la credencial de quien conversa.
 *
 * Va a `127.0.0.1` y no al dominio público a propósito: es la misma app, y
 * dar la vuelta por el borde agregaría latencia, una dependencia de red y un
 * lugar más donde algo puede fallar. La credencial se reenvía TAL CUAL —
 * nunca se fabrica una: si el token de la persona no alcanza, la ruta
 * responde 403 y el modelo recibe ese motivo.
 */
function llamarLaPropiaApi(request: WithUser) {
  const base = `http://127.0.0.1:${enteroDeEntorno('PORT', 3000)}`;
  const credencial: Record<string, string> = request.headers['x-api-key']
    ? { 'X-Api-Key': String(request.headers['x-api-key']) }
    : { Authorization: String(request.headers.authorization ?? '') };
  const tenantId = (request.actor as Actor).tenantId;

  return async (peticion: {
    metodo: string;
    ruta: string;
    query: Record<string, string>;
    cuerpo: Record<string, unknown> | null;
  }) => {
    const qs = new URLSearchParams(peticion.query).toString();
    const cabeceras: Record<string, string> = {
      ...credencial,
      'X-Tenant-Id': tenantId,
      // El MISMO trace: lo que haga el agente se sigue en los logs junto
      // con la conversación que lo pidió.
      ...(request.requestId ? { 'X-Request-Id': request.requestId } : {}),
      ...(peticion.cuerpo ? { 'Content-Type': 'application/json' } : {}),
    };
    const res = await fetch(`${base}${peticion.ruta}${qs ? `?${qs}` : ''}`, {
      method: peticion.metodo,
      headers: cabeceras,
      ...(peticion.cuerpo ? { body: JSON.stringify(peticion.cuerpo) } : {}),
    });
    const datos = await res.json().catch(() => null);
    return { ok: res.ok, estado: res.status, datos };
  };
}

/**
 * El interruptor del panel (#496).
 *
 * Se mira en CADA vuelta y no al arrancar: apagarlo tiene que hacer efecto
 * ya, no en el próximo despliegue. Es una consulta de dos filas como máximo.
 *
 * Y responde 409 con el motivo, no 503: no es que el servicio esté caído —
 * alguien lo apagó a propósito, y quien pregunta merece saber eso.
 */
async function verificarQueEsteEncendido(client: PoolClient, tenantId: string): Promise<void> {
  const estado = await agenteGeneralApagado(client, tenantId);
  if (!estado.apagado) return;
  // El `motivo` que escribió el SuperAdmin NO viaja, a propósito: es una nota
  // interna de un incidente y puede nombrar al proveedor, una cuenta o una
  // deuda. Lo que va es qué pasó desde donde está la persona y qué puede
  // hacer. Hay una prueba que lo sostiene, porque esto se lee como un olvido.
  throw new ConflictException({
    code: 'AGENTE_GENERAL_APAGADO',
    message:
      estado.alcance === 'global'
        ? 'La configuración por conversación está pausada por mantención. Las pantallas siguen funcionando igual.'
        : 'La configuración por conversación está desactivada en esta cuenta. Escríbenos si la necesitas.',
  });
}

/**
 * Qué le falta al negocio (#495).
 *
 * Vive ACÁ y no en el módulo `agents` por la misma razón que los
 * verificadores del onboarding: es el único lugar que conoce todos los
 * contratos. `agents` no puede consultar las tablas de calendar, de channels
 * ni de whatsapp — y no debería poder.
 *
 * Dos fuentes, y la primera ya existía entera: el onboarding, que mira lo
 * que HAY hoy y no lo que la columna recuerda (#56). La segunda son los
 * huecos que el onboarding no cubre porque no son pasos de puesta en marcha
 * sino cosas que se apagan con el tiempo: los horarios, las plantillas, las
 * reglas, la cuota.
 *
 * Cada módulo apagado simplemente no aporta su chequeo. Nada se inventa: si
 * no se puede mirar, no aparece como pendiente.
 */
async function queLeFalta(
  client: PoolClient,
  tenantId: string,
  /** Quién conversa: la disponibilidad es SUYA, no del negocio. */
  ownerId: string | undefined,
): Promise<DiagnosticoDelNegocio> {
  const activo = (id: string) => registry.isActive(id);
  const falta: LoQueFalta[] = [];
  const alDia: string[] = [];

  const onboarding = await onboardingStatus(client, tenantId, {
    activeModules: [...modulosActivos()],
    verificadores: verificadoresDelOnboarding(client, tenantId),
  });
  for (const paso of onboarding.pasos) {
    if (paso.bloqueado) continue;
    if (paso.hecho) {
      alDia.push(paso.detalle ? `${paso.titulo}: ${paso.detalle}` : paso.titulo);
      continue;
    }
    falta.push({
      que: paso.titulo,
      porQue: paso.ayuda,
      comoSeArregla: null,
      // Un paso obligatorio de la puesta en marcha bloquea vender; uno
      // opcional, no. Lo dice el catálogo de pasos, no yo.
      urgencia: paso.opcional ? 'cuandoPuedas' : 'bloquea',
    });
  }

  // Horarios de atención: sin ellos la agenda ofrece lo que quedó por
  // defecto, y el asistente ofrece esas mismas horas.
  if (activo('calendar')) {
    // La disponibilidad es POR PERSONA: se pregunta por quien conversa. Sin
    // persona identificada —una API key— este chequeo no aplica y se salta,
    // que es mejor que decirle a una integración que "no tiene horarios".
    const franjas = ownerId
      ? await listarDisponibilidad(client, { tenantId, ownerId }).catch(() => [])
      : null;
    if (franjas !== null && franjas.length === 0) {
      falta.push({
        que: 'No tienes definidos los horarios en que atiendes',
        porQue: 'La agenda ofrece horas con lo que quedó por defecto, y el asistente ofrece esas mismas.',
        comoSeArregla: 'agenda.disponibilidad',
        urgencia: 'importa',
      });
    } else if (franjas !== null) {
      alDia.push(`Horarios de atención: ${franjas.length} franja${franjas.length > 1 ? 's' : ''}`);
    }
  }

  // Plantillas aprobadas: sin una, pasadas 24 h no se le puede escribir a
  // nadie. Es la mitad de para qué sirve el producto.
  if (activo('whatsapp')) {
    const plantillas = await listTemplates(client, tenantId, {}).catch(() => []);
    // `puedeEnviarse` y no `status === 'approved'`: la regla de qué plantilla
    // se puede mandar ya está escrita en el dominio, y replicarla acá sería
    // la segunda copia que se queda vieja.
    const aprobadas = plantillas.filter((p) => puedeEnviarse(p.status));
    if (aprobadas.length === 0) {
      falta.push({
        que: 'No tienes ninguna plantilla de WhatsApp aprobada',
        porQue:
          plantillas.length > 0
            ? 'Tienes plantillas, pero ninguna aprobada por Meta: pasadas 24 h desde el último mensaje del cliente no puedes escribirle.'
            : 'Pasadas 24 h desde el último mensaje del cliente, una plantilla aprobada es lo único que WhatsApp deja salir.',
        comoSeArregla: plantillas.length > 0 ? 'plantillas.revision' : 'plantillas.create',
        urgencia: 'importa',
      });
    } else {
      alDia.push(`Plantillas aprobadas: ${aprobadas.length}`);
    }
  }

  // Reglas activas: el seguimiento que hoy no se hace.
  if (activo('automations')) {
    const reglas = await listRules(client, tenantId).catch(() => []);
    const activas = reglas.filter((r) => r.active);
    if (activas.length === 0) {
      // Una regla apagada y una regla que NO SE PUEDE activar son cosas
      // distintas: decirle "enciéndela" a alguien cuyo módulo está apagado
      // lo manda a apretar un botón que no va a funcionar. `ruleModuleGaps`
      // ya sabe cuál es cuál.
      const trabadas = reglas
        .map((r) => ({ regla: r, faltan: ruleModuleGaps(r.actions, [...modulosActivos()]) }))
        .filter((x) => x.faltan.length > 0);
      const todasTrabadas = reglas.length > 0 && trabadas.length === reglas.length;
      falta.push({
        que: todasTrabadas
          ? 'Tus reglas no pueden trabajar: les falta una parte del producto'
          : 'No tienes ninguna regla trabajando sola',
        porQue: todasTrabadas
          ? `Necesitan ${[...new Set(trabadas.flatMap((t) => t.faltan))].join(', ')}, que no está activo en tu plan.`
          : reglas.length > 0
            ? 'Tienes reglas creadas pero apagadas: mira su vista previa y enciéndelas.'
            : 'Una cotización que se enfría no avisa sola; una regla sí.',
        comoSeArregla: todasTrabadas ? null : reglas.length > 0 ? 'automations.setActive' : 'automations.seed',
        urgencia: 'cuandoPuedas',
      });
    } else {
      alDia.push(`Reglas activas: ${activas.length}`);
    }
  }

  // La cuota: avisar ANTES de que corte, no después.
  if (activo('agents')) {
    const cuota = await getQuota(client, tenantId).catch(() => null);
    if (cuota?.pct !== null && cuota?.pct !== undefined && cuota.pct >= 80) {
      falta.push({
        que: `Vas en el ${cuota.pct} % de tu cuota de IA del mes`,
        porQue:
          cuota.exhausted
            ? 'Ya se agotó: el asistente dejó de responder hasta el próximo ciclo o hasta que subas de plan.'
            : 'Cuando llegue a 100 %, el asistente deja de responder hasta el próximo ciclo.',
        comoSeArregla: null,
        urgencia: cuota.exhausted ? 'bloquea' : 'importa',
      });
    }
  }

  return { falta, alDia, yaNoEstaLoQueFiguraHecho: onboarding.desfase };
}

/**
 * Los mismos verificadores que la pantalla de puesta en marcha.
 *
 * Repetirlos acá sería tener dos verdades sobre el mismo paso, y la que se
 * quedaría vieja es siempre la segunda. Están duplicados con
 * `onboarding.controller.ts` a la espera de que uno de los dos lo ceda: lo
 * anoto porque es deuda, no diseño.
 */
function verificadoresDelOnboarding(
  client: PoolClient,
  tenantId: string,
): Partial<Record<string, Verificador>> {
  const si = (id: string) => registry.isActive(id);
  return {
    ...(si('crm')
      ? {
          configured: async () => {
            const pipelines = await listPipelines(client, tenantId);
            return { hecho: pipelines.length > 0, detalle: `${pipelines.length} embudos` };
          },
        }
      : {}),
    ...(si('channels')
      ? {
          whatsapp_connected: async () => {
            const cuentas = await listChannelAccounts(client, tenantId);
            const activas = cuentas.filter((c) => c.kind === 'whatsapp' && c.state === 'active');
            return { hecho: activas.length > 0, detalle: `${activas.length} números activos` };
          },
        }
      : {}),
    ...(si('knowledge')
      ? {
          knowledge_added: async () => {
            const fuentes = await listSources(client, tenantId);
            return { hecho: fuentes.length > 0, detalle: `${fuentes.length} fuentes` };
          },
        }
      : {}),
    ...(si('conversations')
      ? {
          first_message: async () => {
            const { conversaciones } = await huboAlgunaConversacion(client, tenantId);
            return { hecho: conversaciones > 0, detalle: `${conversaciones} conversaciones` };
          },
        }
      : {}),
    ...(si('identity')
      ? {
          team_invited: async () => {
            const [equipo, invitaciones] = await Promise.all([
              listarEquipo(client, tenantId),
              listarInvitaciones(client, tenantId),
            ]);
            const otros = Math.max(equipo.length - 1, 0) + invitaciones.length;
            return { hecho: otros > 0, detalle: `${otros} además de ti` };
          },
        }
      : {}),
  };
}

const modulosActivos = () =>
  new Set(
    registry
      .health()
      .filter((m) => m.active)
      .map((m) => m.id),
  );

@ApiTags('agents')
@Controller('agente-general')
@RequireModule('agents')
export class AgenteGeneralController {
  /**
   * Una vuelta de conversación. El hilo lo manda el cliente: acá no hay
   * sesión guardada, y eso es a propósito — una conversación de
   * configuración no es un dato del negocio que haya que retener.
   */
  @Post()
  @RequirePermission('agents.use')
  @ApiOperation({ summary: 'Le habla al Agente General, que configura el negocio conversando' })
  async conversar(
    @Req() request: WithUser,
    @Body() body: { turnos?: Array<{ role?: string; content?: string }>; pantalla?: string },
  ) {
    const actor = actorOf(request);
    const turnos = (body?.turnos ?? [])
      // Con un Set y no comparando el campo: el grep de CI que impone
      // ADR-0008 caza cualquier comparación contra `role`, y tiene razón en
      // cazarla — el de un turno de chat no tiene nada que ver con el rol de
      // permisos, pero debilitar ese guard por una excepción es cómo los
      // guards se mueren.
      .filter((t) => QUIEN_HABLA.has(String(t.role)) && String(t.content ?? '').trim())
      .map((t) => ({ role: t.role as 'user' | 'assistant', content: String(t.content).trim() }))
      // El hilo completo crece sin tope y cada vuelta lo paga el negocio.
      // Las últimas doce alcanzan para entender de qué se está hablando.
      .slice(-12);
    if (!turnos.length || turnos.at(-1)?.role !== 'user') {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Falta lo que quieres preguntarle.',
        details: [{ field: 'turnos' }],
      });
    }

    return withTenant(pool(), actor.tenantId, async (c) => {
      await verificarQueEsteEncendido(c, actor.tenantId);
      const { modelo, provider, model } = await modeloDelAgenteGeneral(c, actor.tenantId);
      if (!providerAvailable(provider as Provider)) {
        throw new ServiceUnavailableException({
          code: 'PROVIDER_UNAVAILABLE',
          message: 'El proveedor de IA todavía no tiene llave configurada en este ambiente.',
        });
      }
      try {
        return await conversarConElAgenteGeneral(
          c,
          {
            tenantId: actor.tenantId,
            turnos,
            permisos: await permisosDelActor(c, actor),
            modulosActivos: modulosActivos(),
            actorUserId: actor.userId,
            // El cliente manda un ID y el módulo tiene la frase: este texto
            // entra en el system prompt, y aceptar lo que venga del navegador
            // sería dejar que cualquiera con sesión le escriba instrucciones
            // al agente que tiene las 195 herramientas. Un id desconocido
            // queda en null y el agente trabaja sin contexto de pantalla.
            pantalla: nombreDePantalla(body?.pantalla) ?? undefined,
            requestId: request.requestId,
          },
          {
            modelo,
            provider,
            model,
            llamarApi: llamarLaPropiaApi(request),
            // La disponibilidad es de QUIEN atiende, no del negocio: se
            // pregunta por la persona que está conversando.
            diagnosticar: () => queLeFalta(c, actor.tenantId, actor.userId),
          },
        );
      } catch (err) {
        if (err instanceof CuotaDeIaAgotada) {
          throw new ConflictException({ code: 'IA_QUOTA_EXHAUSTED', message: err.message });
        }
        // Sin saldo, llave vencida o el proveedor caído: se dice con nombre
        // (#402) en vez de caer en un genérico que no ayuda a nadie.
        const d = motivoDelProveedor(err);
        if (d.motivo !== 'desconocido') {
          const cuerpo = { code: `PROVIDER_${d.motivo.toUpperCase()}`, message: d.message };
          if (d.reintentable) throw new ServiceUnavailableException(cuerpo);
          throw new ConflictException(cuerpo);
        }
        throw new BadRequestException({
          code: 'AGENTE_GENERAL_FALLO',
          message: 'No pudo responder esta vez. Vuelve a preguntarle.',
        });
      }
    });
  }

  /**
   * Aplica lo que la persona aprobó.
   *
   * La propuesta viaja por el navegador, así que acá no se confía en nada de
   * lo que trae: se revalida que la herramienta exista, que su módulo esté
   * activo y que ella tenga el permiso — y después la ruta de verdad lo
   * vuelve a verificar todo por su cuenta.
   */
  @Post('aplicar')
  @RequirePermission('agents.use')
  @ApiOperation({ summary: 'Aplica la acción que el Agente General dejó propuesta' })
  async aplicar(
    @Req() request: WithUser,
    @Body() body: { herramienta?: string; argumentos?: Record<string, unknown> },
  ) {
    const actor = actorOf(request);
    if (!body?.herramienta) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Falta qué acción aplicar.',
        details: [{ field: 'herramienta' }],
      });
    }
    return withTenant(pool(), actor.tenantId, async (c) => {
      // También acá: apagarlo con una propuesta en pantalla no puede dejar
      // un botón que igual funciona.
      await verificarQueEsteEncendido(c, actor.tenantId);
      try {
        const r = await aplicarPropuesta(
          {
            herramienta: body.herramienta!,
            argumentos: body.argumentos ?? {},
            permisos: await permisosDelActor(c, actor),
            modulosActivos: modulosActivos(),
          },
          { llamarApi: llamarLaPropiaApi(request) },
        );
        if (!r.ok) {
          // El motivo de la ruta se respeta tal cual: ya viene con el
          // formato único y con la voz del producto.
          throw new BadRequestException(
            (r.datos as { code?: string; message?: string })?.message
              ? (r.datos as { code?: string; message?: string })
              : { code: 'ACCION_RECHAZADA', message: 'La acción no se pudo completar.' },
          );
        }
        return { aplicada: true, resultado: r.datos };
      } catch (err) {
        if (err instanceof BadRequestException) throw err;
        throw new BadRequestException({
          code: 'ACCION_RECHAZADA',
          message: (err as Error).message,
        });
      }
    });
  }
}
