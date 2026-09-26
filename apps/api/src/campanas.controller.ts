import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { withTenant } from '@iaxti/db';
import {
  crearCampana,
  enviarCampana,
  guardarSegmento,
  listarCampanas,
  listarSegmentos,
  obtenerCampana,
  previsualizarCampana,
  previsualizarSegmento,
  resultadosDeCampana,
  type FiltrosSegmento,
} from '@iaxti/module-automations';
import { canReceiveBusinessInitiated } from '@iaxti/module-crm';
import { sendMessage } from '@iaxti/module-conversations';
import { enviarPlantilla, getTemplate, numeroEnRojo } from '@iaxti/module-whatsapp';
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

  @Post(':id/enviar')
  @RequirePermission('automations.manage')
  @ApiOperation({ summary: 'Manda la campaña: cada destinatario queda con su resultado' })
  async enviar(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    const requestId = (request as { requestId?: string }).requestId;
    try {
      const res = await withTenant(pool(), actor.tenantId, async (c) =>
        enviarCampana(
          c,
          { tenantId: actor.tenantId, campaignId: id, actor: actor.userId, actorKind: actor.kind === 'apikey' ? 'apikey' : 'user', requestId },
          {
            calidadDelNumero: async () =>
              (await numeroEnRojo(c, actor.tenantId)) ? 'rojo' : 'verde',
            puedeIniciar: (contactId) => canReceiveBusinessInitiated(c, actor.tenantId, contactId),
            datosDelContacto: async (contactId) => {
              const r = await c.query(
                'SELECT name, phone FROM contacts WHERE tenant_id = $1 AND id = $2',
                [actor.tenantId, contactId],
              );
              return r.rows[0] ?? {};
            },
            conversacionDe: async (contactId) => {
              const r = await c.query(
                `SELECT id FROM conversations
                  WHERE tenant_id = $1 AND contact_id = $2 AND channel = 'whatsapp'
                  ORDER BY last_message_at DESC NULLS LAST LIMIT 1`,
                [actor.tenantId, contactId],
              );
              return (r.rows[0]?.id as string) ?? null;
            },
            enviarPlantilla: async ({ conversationId, contactId, templateId, valores }) => {
              const env = await enviarPlantilla(
                c,
                {
                  tenantId: actor.tenantId,
                  conversationId,
                  templateId,
                  valores,
                  authorId: actor.userId,
                  requestId,
                },
                {
                  contactoDe: async () => contactId,
                  puedeIniciar: () => canReceiveBusinessInitiated(c, actor.tenantId, contactId),
                  crearMensaje: (m) =>
                    sendMessage(c, {
                      tenantId: m.tenantId,
                      conversationId: m.conversationId,
                      authorKind: 'user',
                      authorId: m.authorId,
                      body: m.body,
                      requestId: m.requestId,
                      delivery: 'business',
                      actorKind: actor.kind === 'apikey' ? 'apikey' : 'user',
                    }),
                },
              );
              return { messageId: env.messageId };
            },
          },
        ),
      );

      return res;
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
