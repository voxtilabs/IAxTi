import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { withTenant } from '@iaxti/db';
import type { PoolClient } from 'pg';
import { listChannelAccounts } from '@iaxti/module-channels';
import {
  createTemplate,
  crearEnZavu,
  enviarARevisionEnZavu,
  enviarPlantilla,
  getTemplate,
  listTemplates,
  marcarEnviadaARevision,
  updateTemplate,
  type EstadoPlantilla,
} from '@iaxti/module-whatsapp';
import { canReceiveBusinessInitiated } from '@iaxti/module-crm';
import { sendMessage } from '@iaxti/module-conversations';
import { RequireModule, RequirePermission } from './authz/decorators';
import type { Actor, WithUser } from './authz/authz.guard';
import { apiPool } from './db';
import { createQueue, redisConnection } from '@iaxti/core';

/**
 * Plantillas de WhatsApp (#44).
 *
 * Fuera de la ventana de 24 h es lo único que Meta deja salir. Administrar
 * el catálogo es del ADMIN; enviar una es de cualquiera que pueda responder
 * en la bandeja — la plantilla no da permisos nuevos, solo hace posible
 * escribir cuando la conversación se enfrió.
 */
/** La misma cola que usa la bandeja: una plantilla no tiene atajo propio. */
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

/**
 * La cuenta de WhatsApp del negocio, con su credencial POR REFERENCIA. Si no
 * hay número conectado no hay a quién pedirle la aprobación, y decirlo así
 * es más útil que un error del proveedor.
 */
async function cuentaDeWhatsApp(
  c: PoolClient,
  tenantId: string,
): Promise<{ cfg: { apiKey: string }; senderId: string }> {
  const cuentas = await listChannelAccounts(c, tenantId);
  const cuenta = cuentas.find((a) => a.kind === 'whatsapp' && a.state === 'active');
  if (!cuenta) {
    throw new Error('Primero conecta el número de WhatsApp del negocio en Ajustes → Canales.');
  }
  const apiKey = cuenta.credentialRef ? process.env[cuenta.credentialRef] : undefined;
  if (!apiKey) {
    throw new Error(
      `Falta la variable ${cuenta.credentialRef} en este ambiente (credenciales por referencia).`,
    );
  }
  const senderId = cuenta.config.senderId as string | undefined;
  if (!senderId) throw new Error('La cuenta de WhatsApp no tiene senderId configurado.');
  return { cfg: { apiKey }, senderId };
}

function seVeMal(err: unknown): never {
  const mensaje = (err as Error).message;
  if (mensaje === 'SIN_CONSENTIMIENTO') {
    throw new BadRequestException({
      code: 'SIN_CONSENTIMIENTO',
      message: 'Esa persona no dio su consentimiento para recibir mensajes del negocio.',
    });
  }
  throw new BadRequestException({ code: 'VALIDATION_ERROR', message: mensaje });
}

@ApiTags('whatsapp')
@Controller('plantillas')
@RequireModule('whatsapp')
export class PlantillasController {
  @Get()
  @RequirePermission('conversations.reply')
  @ApiOperation({ summary: 'Plantillas del negocio y su estado' })
  async list(@Req() request: WithUser, @Query('estado') estado?: string) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) =>
      listTemplates(c, actor.tenantId, { status: estado as EstadoPlantilla | undefined }),
    );
  }

  @Post()
  @RequirePermission('whatsapp.templates.manage')
  @ApiOperation({ summary: 'Crea una plantilla en borrador' })
  async create(@Req() request: WithUser, @Body() body: Record<string, never>) {
    const actor = actorOf(request);
    try {
      return await withTenant(pool(), actor.tenantId, (c) =>
        createTemplate(c, { tenantId: actor.tenantId, ...(body as object) } as never),
      );
    } catch (err) {
      seVeMal(err);
    }
  }

  @Put(':id')
  @RequirePermission('whatsapp.templates.manage')
  @ApiOperation({ summary: 'Corrige una plantilla en borrador o rechazada' })
  async update(@Req() request: WithUser, @Param('id') id: string, @Body() body: Record<string, never>) {
    const actor = actorOf(request);
    try {
      return await withTenant(pool(), actor.tenantId, (c) =>
        updateTemplate(c, { tenantId: actor.tenantId, templateId: id, ...(body as object) } as never),
      );
    } catch (err) {
      seVeMal(err);
    }
  }

  /**
   * Marca la plantilla como mandada a revisión. El viaje al proveedor lo
   * hace quien tiene las llaves; acá se registra el paso para que la
   * interfaz no diga "en revisión" antes de que alguien la haya mandado.
   */
  @Post(':id/revision')
  @RequirePermission('whatsapp.templates.manage')
  @ApiOperation({ summary: 'Manda la plantilla a revisión de Meta' })
  async revision(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    try {
      return await withTenant(pool(), actor.tenantId, async (c) => {
        const plantilla = await getTemplate(c, actor.tenantId, id);
        const cuenta = await cuentaDeWhatsApp(c, actor.tenantId);

        // Primero el viaje al proveedor, después la marca. Al revés, un fallo
        // de red dejaría la plantilla diciendo "en revisión" sin que nadie la
        // haya mandado, y la espera sería eterna.
        const enZavu = plantilla.providerId
          ? await enviarARevisionEnZavu(cuenta.cfg, {
              templateId: plantilla.providerId,
              senderId: cuenta.senderId,
              category: plantilla.category,
            })
          : await (async () => {
              const creada = await crearEnZavu(cuenta.cfg, {
                name: plantilla.name,
                language: plantilla.language,
                body: plantilla.body,
                category: plantilla.category,
                footer: plantilla.footer,
                buttons: plantilla.buttons.map((text) => ({ type: 'quick_reply', text })),
              });
              return enviarARevisionEnZavu(cuenta.cfg, {
                templateId: creada.id,
                senderId: cuenta.senderId,
                category: plantilla.category,
              });
            })();

        return marcarEnviadaARevision(c, {
          tenantId: actor.tenantId,
          templateId: id,
          providerId: enZavu.id,
          requestId: (request as { requestId?: string }).requestId,
        });
      });
    } catch (err) {
      seVeMal(err);
    }
  }

  /**
   * La manda a una conversación, esté o no dentro de la ventana de 24 h.
   * Eso es TODO el punto. Lo que no se salta: consentimiento, horario de
   * silencio, pausa por calidad y estado del tenant — esos tres últimos los
   * aplica la cola porque el envío va marcado como iniciado por el negocio.
   */
  @Post(':id/enviar')
  @RequirePermission('conversations.reply')
  @ApiOperation({ summary: 'Envía la plantilla a una conversación (fuera de ventana incluido)' })
  async enviar(
    @Req() request: WithUser,
    @Param('id') id: string,
    @Body() body: { conversationId?: string; valores?: string[] },
  ) {
    const actor = actorOf(request);
    if (!body?.conversationId) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Falta a qué conversación mandarla.',
      });
    }
    try {
      const res = await withTenant(pool(), actor.tenantId, async (c) =>
        enviarPlantilla(
          c,
          {
            tenantId: actor.tenantId,
            conversationId: body.conversationId!,
            templateId: id,
            valores: Array.isArray(body?.valores) ? body.valores : [],
            authorId: actor.userId,
            requestId: (request as { requestId?: string }).requestId,
          },
          {
            contactoDe: async (conversationId) => {
              const r = await c.query(
                'SELECT contact_id FROM conversations WHERE tenant_id = $1 AND id = $2',
                [actor.tenantId, conversationId],
              );
              if (r.rowCount === 0) throw new Error('Esa conversación no existe en este negocio.');
              return r.rows[0].contact_id as string;
            },
            puedeIniciar: (contactId) =>
              canReceiveBusinessInitiated(c, actor.tenantId, contactId),
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
        ),
      );
      // La cola aplica el silencio, la pausa por calidad y el estado del
      // tenant. Va marcada como iniciada por el negocio porque lo es: la
      // conversación estaba fría y la estamos reabriendo nosotros.
      await outboundQueue().add(
        'send',
        {
          moduleId: 'whatsapp',
          tenantId: actor.tenantId,
          messageId: res.messageId,
          requestId: (request as { requestId?: string }).requestId,
          initiatedByBusiness: true,
        },
        { jobId: `out-${res.messageId}` },
      );
      return { messageId: res.messageId, texto: res.texto, plantilla: res.plantilla.name };
    } catch (err) {
      seVeMal(err);
    }
  }
}
