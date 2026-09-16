import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createQueue, redisConnection } from '@iaxti/core';
import { withTenant } from '@iaxti/db';
import {
  crearCampana,
  enviarCampana,
  guardarSegmento,
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
import { RequireModule, RequirePermission } from './authz/decorators';
import type { Actor, WithUser } from './authz/authz.guard';
import { apiPool } from './db';

/**
 * Envíos segmentados (#75).
 *
 * "Mándale la promo a todos los que cotizaron y no compraron". Antes de que
 * salga, dos cosas obligatorias: la vista previa con el conteo exacto y la
 * muestra, y la calidad del número en verde o amarillo.
 */
let colaOutbound: ReturnType<typeof createQueue> | null = null;
function outboundQueue(): ReturnType<typeof createQueue> {
  colaOutbound ??= createQueue('outbound', redisConnection());
  return colaOutbound;
}

function pool() {
  const p = apiPool();
  if (!p) throw new BadRequestException({ code: 'DB_NOT_CONFIGURED', message: 'Sin base de datos.' });
  return p;
}

function actorOf(request: WithUser): Actor {
  return request.actor as Actor;
}

@ApiTags('automations')
@Controller('campanas')
@RequireModule('automations')
export class CampanasController {
  @Post('segmentos/vista-previa')
  @RequirePermission('automations.manage')
  @ApiOperation({ summary: 'Cuántos son y quiénes se ven, antes de mandar nada' })
  async vistaPrevia(@Req() request: WithUser, @Body() body: { filtros?: FiltrosSegmento }) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) =>
      previsualizarSegmento(c, { tenantId: actor.tenantId, filtros: body?.filtros ?? {} }),
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
  async guardar(@Req() request: WithUser, @Body() body: { name?: string; filtros?: FiltrosSegmento }) {
    const actor = actorOf(request);
    try {
      return await withTenant(pool(), actor.tenantId, (c) =>
        guardarSegmento(c, {
          tenantId: actor.tenantId,
          name: body?.name ?? '',
          filtros: body?.filtros ?? {},
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
    @Body() body: { name?: string; templateId?: string; filtros?: FiltrosSegmento; valores?: string[] },
  ) {
    const actor = actorOf(request);
    if (!body?.templateId) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'La campaña necesita una plantilla aprobada.',
      });
    }
    try {
      return await withTenant(pool(), actor.tenantId, (c) =>
        crearCampana(
          c,
          {
            tenantId: actor.tenantId,
            name: body?.name ?? '',
            templateId: body.templateId!,
            filtros: body?.filtros ?? {},
            valores: body?.valores,
            actor: actor.userId,
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
      const encolados: string[] = [];
      const res = await withTenant(pool(), actor.tenantId, async (c) =>
        enviarCampana(
          c,
          { tenantId: actor.tenantId, campaignId: id, actor: actor.userId, requestId },
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
                    }),
                },
              );
              encolados.push(env.messageId);
              return { messageId: env.messageId };
            },
          },
        ),
      );

      // A la cola DESPUÉS de cerrar la transacción: si algo falla al
      // encolar, no queda un mensaje escrito que nadie va a mandar.
      for (const messageId of encolados) {
        await outboundQueue().add(
          'send',
          {
            moduleId: 'whatsapp',
            tenantId: actor.tenantId,
            messageId,
            requestId,
            initiatedByBusiness: true,
          },
          { jobId: `out-${messageId}` },
        );
      }
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
