import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createQueue, redisConnection } from '@iaxti/core';
import { withTenant } from '@iaxti/db';
import {
  crearCampana,
  detenerCampana,
  guardarSegmento,
  iniciarCampana,
  listarCampanas,
  listarSegmentos,
  obtenerCampana,
  previsualizarCampana,
  previsualizarSegmento,
  resultadosDeCampana,
  seguirCampana,
  volverABorrador,
  type FiltrosSegmento,
} from '@iaxti/module-automations';
// El controlador dejó de saber cómo se manda un mensaje cuando dejó de
// mandarlos: eso vive ahora en `apps/workers/src/campanas.ts`, en un solo lugar
// (#609). Acá solo queda lo que hace falta para lanzar: la plantilla y la
// calidad del número.
import { getTemplate, numeroEnRojo } from '@iaxti/module-whatsapp';
import { z } from 'zod';
import { RequireModule, RequirePermission } from './authz/decorators';
import { Cuerpo, textoRequerido } from './validar';
import type { Actor, WithUser } from './authz/authz.guard';
import { apiPool } from './db';

/**
 * Envíos segmentados (#75).
 *
 * "Mándale la promo a todos los que cotizaron y no compraron". Antes de que
 * salga, dos cosas obligatorias: la vista previa con el conteo exacto y la
 * muestra, y la calidad del número en verde o amarillo.
 */

function pool() {
  const p = apiPool();
  if (!p) throw new BadRequestException({ code: 'DB_NOT_CONFIGURED', message: 'Sin base de datos.' });
  return p;
}

function actorOf(request: WithUser): Actor {
  return request.actor as Actor;
}

/**
 * La cola donde sale la campaña. Perezosa, como la de pagos: sin `REDIS_URL`
 * el resto del controlador —crear, previsualizar, listar— sigue funcionando.
 */
let colaAutomations: ReturnType<typeof createQueue> | null = null;
function campanasQueue(): ReturnType<typeof createQueue> {
  colaAutomations ??= createQueue('automations', redisConnection());
  return colaAutomations;
}

/**
 * Los esquemas de entrada (#524), al lado de sus rutas.
 *
 * El mensaje va escrito acá porque es lo que lee quien está armando un envío
 * para su cartera, no un «Required».
 */

/**
 * Los filtros entran como vengan, sin describirles la forma.
 *
 * Hoy esta ruta no valida ni un filtro: quien los interpreta es el segmento,
 * que ignora lo que no conoce y normaliza lo que sí (un `sinActividadDias` que
 * llega como texto pasa por `Number`). Declarar la forma acá volvería eso un
 * VALIDATION_ERROR que antes no existía, y lo que se pierde es justo la vista
 * previa —el conteo antes de mandar—, que es lo que no debería fallar nunca.
 * De ahí el cast al llamar: el tipo dice lo mismo que decía el `@Body()`.
 *
 * Y va `.optional()` de forma explícita: un `z.unknown()` suelto dentro de un
 * objeto SÍ exige la clave, y sin filtros —que es el caso de «mándale a
 * todos»— la ruta respondía 400 con el «expected nonoptional» de zod.
 */
const filtrosComoVengan = z.unknown().optional();

/** El cuerpo de la vista previa del segmento. */
const VistaPreviaDeSegmento = z.object({ filtros: filtrosComoVengan });

/** El cuerpo de guardar un segmento con nombre. */
const NuevoSegmento = z.object({
  // El nombre NO va al esquema: lo exige `guardarSegmento` con su propio texto
  // («El segmento necesita un nombre.») y el catch de la ruta lo saca como
  // VALIDATION_ERROR. Escribirlo también acá es el mismo mensaje en dos
  // lugares, listo para separarse en el primer cambio de redacción.
  name: z.string().trim().optional(),
  filtros: filtrosComoVengan,
});

/** El cuerpo de crear una campaña en borrador. */
const NuevaCampana = z.object({
  // La plantilla primero: era el único `if` de la ruta y corría antes que
  // cualquier otra comprobación, así que con varios campos malos el mensaje
  // que se lee sigue siendo este. El orden de las claves es el de los
  // `details`, y el primero es el que se lee.
  templateId: textoRequerido('La campaña necesita una plantilla aprobada.'),
  // El nombre lo exige `crearCampana`, igual que el del segmento. Y que los
  // `valores` sean tantos como las variables de la plantilla también se
  // comprueba allá: hay que preguntarle a la plantilla, que el esquema no ve.
  name: z.string().trim().optional(),
  filtros: filtrosComoVengan,
  valores: z.array(z.string()).optional(),
});

@ApiTags('automations')
@Controller('campanas')
@RequireModule('automations')
export class CampanasController {
  @Post('segmentos/vista-previa')
  @RequirePermission('automations.manage')
  @ApiOperation({ summary: 'Cuántos son y quiénes se ven, antes de mandar nada' })
  async vistaPrevia(
    @Req() request: WithUser,
    @Cuerpo(VistaPreviaDeSegmento) body: z.infer<typeof VistaPreviaDeSegmento>,
  ) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) =>
      previsualizarSegmento(c, {
        tenantId: actor.tenantId,
        filtros: (body.filtros ?? {}) as FiltrosSegmento,
      }),
    );
  }

  @Get('segmentos')
  @RequirePermission('automations.manage')
  @ApiOperation({ summary: 'Segmentos guardados' })
  async segmentos(@Req() request: WithUser) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) => listarSegmentos(c, actor.tenantId));
  }

  @Post('segmentos')
  @RequirePermission('automations.manage')
  @ApiOperation({ summary: 'Guarda un segmento con nombre' })
  async guardar(
    @Req() request: WithUser,
    @Cuerpo(NuevoSegmento) body: z.infer<typeof NuevoSegmento>,
  ) {
    const actor = actorOf(request);
    try {
      return await withTenant(pool(), actor.tenantId, (c) =>
        guardarSegmento(c, {
          tenantId: actor.tenantId,
          name: body.name ?? '',
          filtros: (body.filtros ?? {}) as FiltrosSegmento,
          actor: actor.userId,
        }),
      );
    } catch (err) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: (err as Error).message });
    }
  }

  @Post()
  @RequirePermission('automations.manage')
  @ApiOperation({ summary: 'Crea una campaña en borrador' })
  async crear(
    @Req() request: WithUser,
    @Cuerpo(NuevaCampana) body: z.infer<typeof NuevaCampana>,
  ) {
    const actor = actorOf(request);
    try {
      return await withTenant(pool(), actor.tenantId, (c) =>
        crearCampana(
          c,
          {
            tenantId: actor.tenantId,
            name: body.name ?? '',
            templateId: body.templateId,
            filtros: (body.filtros ?? {}) as FiltrosSegmento,
            valores: body.valores,
            actor: actor.userId,
            actorKind: actor.kind === 'apikey' ? 'apikey' : 'user',
            requestId: request.requestId,
          },
          {
            variablesDePlantilla: async (templateId) =>
              (await getTemplate(c, actor.tenantId, templateId)).variables,
          },
        ),
      );
    } catch (err) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: (err as Error).message });
    }
  }

  @Get()
  @RequirePermission('automations.manage')
  @ApiOperation({ summary: 'Las campañas del negocio, la más reciente primero' })
  async listar(@Req() request: WithUser, @Query('limite') limite?: string) {
    const actor = actorOf(request);
    const n = Number(limite);
    return withTenant(pool(), actor.tenantId, (c) =>
      listarCampanas(c, actor.tenantId, { limite: Number.isFinite(n) && n > 0 ? n : undefined }),
    );
  }

  @Get(':id/vista-previa')
  @RequirePermission('automations.manage')
  @ApiOperation({ summary: 'A quién le llegaría esta campaña' })
  async previa(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) =>
      previsualizarCampana(c, { tenantId: actor.tenantId, campaignId: id }),
    );
  }

  /**
   * Lanza la campaña. **No la manda**: la deja lista y encola (#609, #610).
   *
   * Antes esta ruta recorría el segmento completo acá mismo, dentro del request
   * y dentro de una sola transacción. 900 contactos en un request HTTP es un
   * timeout esperando ocurrir, y cuando el tope del canal cortaba a mitad de
   * camino la campaña se reportaba como ENVIADA igual.
   *
   * Devuelve 202 y el total congelado: el progreso se mira en
   * `GET :id/resultados`, que ya existía y ahora tiene qué mostrar mientras sale.
   */
  @Post(':id/enviar')
  @HttpCode(202)
  @RequirePermission('automations.manage')
  @ApiOperation({ summary: 'Lanza la campaña: queda saliendo por lotes, con su total congelado' })
  async enviar(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    const requestId = (request as { requestId?: string }).requestId;
    try {
      const res = await withTenant(pool(), actor.tenantId, (c) =>
        iniciarCampana(
          c,
          {
            tenantId: actor.tenantId,
            campaignId: id,
            actor: actor.userId,
            actorKind: actor.kind === 'apikey' ? 'apikey' : 'user',
            requestId,
          },
          {
            calidadDelNumero: async () =>
              (await numeroEnRojo(c, actor.tenantId)) ? 'rojo' : 'verde',
          },
        ),
      );

      // Se encola DESPUÉS del commit, a propósito: encolar dentro de la
      // transacción deja el job pidiendo una campaña `sending` que todavía no
      // existe para nadie más, y el worker se la encuentra en `draft`.
      //
      // Y si encolar falla —Redis caído—, la campaña se devuelve a `draft`. Sin
      // esto quedaría `sending` para siempre, con el dueño mirando un progreso
      // que nadie va a mover y sin botón para relanzarla: `iniciarCampana`
      // rechaza todo lo que no sea `draft`. Un estado que miente es peor que un
      // error, porque el error se puede reintentar.
      try {
        await campanasQueue().add('campaign.send', {
          moduleId: 'automations',
          tenantId: actor.tenantId,
          campaignId: id,
          actor: actor.userId,
          actorKind: actor.kind === 'apikey' ? 'apikey' : 'user',
          requestId,
        });
      } catch (err) {
        await withTenant(pool(), actor.tenantId, (c) =>
          volverABorrador(c, { tenantId: actor.tenantId, campaignId: id }),
        );
        throw new Error(
          'No pudimos poner la campaña en la cola de envío, así que volvió a borrador. ' +
            `Intenta de nuevo en un momento. (${(err as Error).message})`,
        );
      }

      return {
        ...res,
        aviso: res.truncado
          ? `El segmento tiene más de ${res.total} contactos y esta campaña va a los primeros ${res.total}. ` +
            'El tope es nuestro, no del canal: para llegar al resto, parte el segmento.'
          : null,
      };
    } catch (err) {
      throw new BadRequestException({ code: 'CAMPANA_RECHAZADA', message: (err as Error).message });
    }
  }

  /**
   * Detener una campaña que está saliendo mal (#610).
   *
   * Mismo permiso que lanzarla, sin pedir uno nuevo: el daño corre mientras se
   * busca a quien tenga un permiso especial.
   *
   * El aviso no promete lo que no podemos cumplir. Lo que ya se mandó al
   * proveedor **puede alcanzar a entregarse** —lo dice su propia documentación—
   * así que se dice así y no «no se envió nada más».
   */
  @Post(':id/detener')
  @RequirePermission('automations.manage')
  @ApiOperation({ summary: 'Detiene una campaña en curso y dice cuántos salieron' })
  async detener(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    const requestId = (request as { requestId?: string }).requestId;
    try {
      const res = await withTenant(pool(), actor.tenantId, (c) =>
        detenerCampana(c, {
          tenantId: actor.tenantId,
          campaignId: id,
          actor: actor.userId,
          actorKind: actor.kind === 'apikey' ? 'apikey' : 'user',
          requestId,
        }),
      );
      return {
        ...res,
        aviso:
          `Detuviste la campaña. Salieron ${res.encolados} y ${res.sinTocar} no se van a enviar. ` +
          'Los últimos que ya estaban en el canal pueden alcanzar a entregarse.',
      };
    } catch (err) {
      throw new BadRequestException({ code: 'CAMPANA_RECHAZADA', message: (err as Error).message });
    }
  }

  /** Seguir una campaña que quedó a medias por el tope del canal (#609). */
  @Post(':id/seguir')
  @HttpCode(202)
  @RequirePermission('automations.manage')
  @ApiOperation({ summary: 'Manda los que quedaron de una campaña a medias' })
  async seguir(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    const requestId = (request as { requestId?: string }).requestId;
    try {
      const campana = await withTenant(pool(), actor.tenantId, (c) =>
        seguirCampana(
          c,
          {
            tenantId: actor.tenantId,
            campaignId: id,
            actor: actor.userId,
            actorKind: actor.kind === 'apikey' ? 'apikey' : 'user',
            requestId,
          },
          {
            calidadDelNumero: async () =>
              (await numeroEnRojo(c, actor.tenantId)) ? 'rojo' : 'verde',
          },
        ),
      );
      await campanasQueue().add('campaign.send', {
        moduleId: 'automations',
        tenantId: actor.tenantId,
        campaignId: id,
        actor: actor.userId,
        actorKind: actor.kind === 'apikey' ? 'apikey' : 'user',
        requestId,
      });
      return { campana };
    } catch (err) {
      throw new BadRequestException({ code: 'CAMPANA_RECHAZADA', message: (err as Error).message });
    }
  }

  @Get(':id/resultados')
  @RequirePermission('automations.manage')
  @ApiOperation({ summary: 'Cómo le fue: enviados, saltados con motivo, entrega y costo' })
  async resultados(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      const campana = await obtenerCampana(c, actor.tenantId, id);
      const r = await resultadosDeCampana(c, { tenantId: actor.tenantId, campaignId: id });
      return { campana, ...r };
    });
  }
}
