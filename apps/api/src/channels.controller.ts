import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { withTenant } from '@iaxti/db';
import { diagnosticarCanal, findAccountById, listChannelAccounts } from '@iaxti/module-channels';
import { writeAudit } from '@iaxti/module-audit';
import {
  clienteZavu,
  desconectarNumero,
  elegirSender,
  emisorDelProveedor,
  emisoresDelProveedor,
  listTemplates,
  listWhatsAppNumbers,
  reapuntarEmisor,
  resumeBusinessSends,
} from '@iaxti/module-whatsapp';
import { createWidget, listWidgets, setWidgetActive } from '@iaxti/module-webchat';
import { z } from 'zod';
import { RequireModule, RequirePermission } from './authz/decorators';
import { Cuerpo, textoRequerido } from './validar';
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

/**
 * El cuerpo para reapuntar un canal (#600).
 *
 * `senderId` obligatorio y nada de «elige tú el único que sirva»: cuando hay
 * uno solo, `elegirSender` lo resolvería sin que nadie confirme, y apuntar el
 * canal de un negocio al emisor equivocado es de las cosas más caras de
 * deshacer. Que lo escriba quien decide.
 */
const OtroEmisor = z.object({
  senderId: textoRequerido('Dinos a qué emisor apuntar este canal.'),
  phoneNumberId: z.string().trim().optional(),
  wabaId: z.string().trim().optional(),
});

/** La pantalla de canales (#45): estado, calidad y la reactivación manual. */
@ApiTags('channels')
@Controller()
@RequireModule('channels')
export class ChannelsController {
  @Get('channels')
  // Mirar el estado de un número —calidad, pausa— es leer; configurarlo es
  // otra cosa. El permiso existía en el catálogo sin que ninguna ruta lo
  // usara. Hoy no cambia quién entra (ADMIN tiene ambos), pero deja la
  // puerta lista para dárselo a SUPERVISOR cuando se decida.
  @RequirePermission('channels.read')
  @ApiOperation({ summary: 'Cuentas de canal con sus números y calidad' })
  async list(@Req() request: WithUser) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      const [accounts, numbers] = await Promise.all([
        listChannelAccounts(c, actor.tenantId),
        listWhatsAppNumbers(c, actor.tenantId).catch(() => []),
      ]);
      return accounts.map((a) => ({
        ...a,
        numbers: numbers.filter((n) => n.channelAccountId === a.id),
      }));
    });
  }

  /**
   * Por qué no llegan los mensajes (#434).
   *
   * Cuatro causas que se arreglan en lugares distintos y que desde adentro
   * se veían todas iguales. Esto las separa y dice qué hacer con cada una,
   * sin entrar a ninguna consola — que es lo que no se podía hacer: la API
   * de Dokploy no expone logs de contenedor.
   */
  @Get('channels/:id/diagnostico')
  @RequirePermission('channels.read')
  @ApiOperation({ summary: 'Por qué este canal no está recibiendo, paso a paso' })
  async diagnostico(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      const cuenta = await findAccountById(c, id);
      if (!cuenta || cuenta.tenantId !== actor.tenantId) {
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'No encontramos ese canal.' });
      }
      const esWhatsApp = cuenta.kind === 'whatsapp';
      return diagnosticarCanal(
        c,
        {
          tenantId: actor.tenantId,
          accountId: id,
          // Para el aviso de «este canal manda de verdad» (#593), que solo sale
          // cuando el ambiente NO es producción.
          ...(process.env.IAXTI_ENV ? { ambiente: process.env.IAXTI_ENV } : {}),
        },
        {
          // Solo se mira si la variable EXISTE. El valor no sale de acá ni
          // en el diagnóstico ni en los logs.
          hayCredencial: (ref) => Boolean(ref && process.env[ref]),
          // Se le PREGUNTA al proveedor si el emisor guardado sigue sirviendo
          // (#591). Antes el paso se daba por bueno con que hubiera un string
          // en `config.senderId`, y había un camino donde todo el diagnóstico
          // salía verde y no salía ni un mensaje.
          //
          // La credencial se lee acá y no se pasa hacia abajo: el diagnóstico
          // recibe una función, nunca la llave.
          ...(cuenta.kind !== 'webchat' && cuenta.kind !== 'simulador'
            ? {
                emisorEnElProveedor: async () => {
                  const senderId = cuenta.config.senderId;
                  const apiKey = cuenta.credentialRef
                    ? process.env[cuenta.credentialRef]
                    : undefined;
                  if (typeof senderId !== 'string' || !senderId || !apiKey) return null;
                  return emisorDelProveedor(clienteZavu(apiKey), senderId);
                },
              }
            : {}),
          ...(esWhatsApp
            ? {
                numeroConectado: async () =>
                  (await listWhatsAppNumbers(c, actor.tenantId)).some(
                    (n) => n.channelAccountId === id && n.connectedAt !== null,
                  ),
                plantillasAprobadas: async () =>
                  (await listTemplates(c, actor.tenantId)).filter((p) => p.status === 'approved').length,
              }
            : {}),
          entrantesRecientes: async () => {
            const r = await c.query(
              `SELECT count(*)::int AS n FROM messages m
                 JOIN conversations v ON v.id = m.conversation_id AND v.tenant_id = m.tenant_id
                WHERE m.tenant_id = $1 AND v.channel_account_id = $2
                  AND m.direction = 'in' AND m.created_at > now() - interval '24 hours'`,
              [actor.tenantId, id],
            );
            return Number(r.rows[0]?.n ?? 0);
          },
        },
      );
    });
  }

  /**
   * Los emisores del proyecto de la llave ACTUAL de este canal (#600).
   *
   * Para elegir con información y no de memoria: el `senderId` se escribe una
   * sola vez y el error se descubre cuando un cliente escribe y nadie le
   * contesta. Viene el `channels` de cada uno y si sirve para ESTE canal, que es
   * el chequeo que `elegirSender` hace al conectar y que acá no se relaja.
   *
   * La credencial se lee del ambiente y no sale de acá: lo que viaja al cliente
   * son ids y nombres de emisores.
   */
  @Get('channels/:id/emisores')
  @RequirePermission('channels.read')
  @ApiOperation({ summary: 'Emisores disponibles en el proyecto de la llave de este canal' })
  async emisores(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    const cuenta = await withTenant(pool(), actor.tenantId, async (c) => {
      const encontrada = await findAccountById(c, id);
      if (!encontrada || encontrada.tenantId !== actor.tenantId) {
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'No encontramos ese canal.' });
      }
      return encontrada;
    });
    const apiKey = cuenta.credentialRef ? process.env[cuenta.credentialRef] : undefined;
    if (!apiKey) {
      throw new ServiceUnavailableException({
        code: 'CREDENTIAL_MISSING',
        message:
          `Este canal guarda su credencial como ${cuenta.credentialRef ?? '(sin referencia)'} y esa ` +
          'variable no está en este ambiente, así que no podemos preguntarle al proveedor qué ' +
          'emisores tiene.',
      });
    }
    const senders = await emisoresDelProveedor(clienteZavu(apiKey));
    if (senders === null) {
      throw new ServiceUnavailableException({
        code: 'PROVIDER_UNAVAILABLE',
        message: 'No pudimos preguntarle al proveedor qué emisores tiene. Intenta en unos minutos.',
      });
    }
    // `sirve` y no filtrar: ver los que NO sirven explica por qué la lista
    // está corta —un emisor existe pero sin este canal encendido— y eso se
    // arregla en Zavu, no acá. Una lista vacía sin explicación manda a adivinar.
    return senders.map((s) => ({
      id: s.id,
      name: s.name ?? null,
      channels: s.channels ?? [],
      sirve: (s.channels ?? []).includes(cuenta.kind),
      actual: cuenta.config.senderId === s.id,
    }));
  }

  /**
   * Reapunta este canal a otro emisor (#600).
   *
   * No crea otra cuenta: cambia la de esta. Las conversaciones cuelgan de la
   * cuenta, así que el historial se queda — es el mismo canal hablando por otra
   * boca.
   */
  @Post('channels/:id/emisor')
  @RequirePermission('channels.manage')
  @ApiOperation({ summary: 'Apunta este canal a otro emisor del proveedor' })
  async cambiarEmisor(
    @Req() request: WithUser,
    @Param('id') id: string,
    @Cuerpo(OtroEmisor) body: z.infer<typeof OtroEmisor>,
  ) {
    const actor = actorOf(request);
    const cuenta = await withTenant(pool(), actor.tenantId, async (c) => {
      const encontrada = await findAccountById(c, id);
      if (!encontrada || encontrada.tenantId !== actor.tenantId) {
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'No encontramos ese canal.' });
      }
      return encontrada;
    });
    const apiKey = cuenta.credentialRef ? process.env[cuenta.credentialRef] : undefined;
    if (!apiKey) {
      throw new ServiceUnavailableException({
        code: 'CREDENTIAL_MISSING',
        message:
          `Este canal guarda su credencial como ${cuenta.credentialRef ?? '(sin referencia)'} y esa ` +
          'variable no está en este ambiente.',
      });
    }
    const senders = await emisoresDelProveedor(clienteZavu(apiKey));
    if (senders === null) {
      throw new ServiceUnavailableException({
        code: 'PROVIDER_UNAVAILABLE',
        message: 'No pudimos preguntarle al proveedor por sus emisores. Intenta en unos minutos.',
      });
    }
    // El MISMO chequeo que al conectar, y por eso se reusa `elegirSender` en vez
    // de escribirlo de nuevo: un emisor sin este canal encendido no manda nada,
    // y la regla no tiene por qué relajarse después de conectar.
    const elegido = elegirSender(senders, cuenta.kind, body.senderId);
    if ('error' in elegido) {
      throw new BadRequestException({
        code: 'SENDER_INVALID',
        message: elegido.error,
        details: elegido.candidatos.map((s) => ({ id: s.id, channels: s.channels ?? [] })),
      });
    }
    return withTenant(pool(), actor.tenantId, async (c) => {
      const { number, account } = await reapuntarEmisor(c, {
        tenantId: actor.tenantId,
        accountId: id,
        senderId: elegido.sender.id,
        ...(body.phoneNumberId === undefined ? {} : { phoneNumberId: body.phoneNumberId }),
        ...(body.wabaId === undefined ? {} : { wabaId: body.wabaId }),
      });
      // En la MISMA transacción: cambiar por dónde habla un canal es de las
      // cosas que alguien va a querer reconstruir después, y el emisor viejo
      // solo existe acá una vez que se sobrescribió.
      await writeAudit(c, {
        tenantId: actor.tenantId,
        actor: actor.userId,
        actorKind: 'user',
        action: 'channel.sender.changed',
        resource: 'channel_account',
        resourceId: id,
        result: 'ok',
        metadata: {
          kind: cuenta.kind,
          desde: cuenta.config.senderId ?? null,
          hacia: elegido.sender.id,
        },
        requestId: request.requestId,
      });
      return { number, account };
    });
  }

  /**
   * Desconecta el canal: archiva, no borra (#600).
   *
   * Libera el cupo del plan y deja las conversaciones donde están. El canal
   * queda `disconnected`, que es lo que apaga los envíos.
   */
  @Post('channels/:id/desconectar')
  @RequirePermission('channels.manage')
  @ApiOperation({ summary: 'Desconecta el canal y libera el cupo del plan (el historial queda)' })
  async desconectar(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      const cuenta = await findAccountById(c, id);
      if (!cuenta || cuenta.tenantId !== actor.tenantId) {
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'No encontramos ese canal.' });
      }
      if (cuenta.kind !== 'whatsapp') {
        throw new BadRequestException({
          code: 'CHANNEL_KIND_UNSUPPORTED',
          message: 'Por ahora solo se puede desconectar un canal de WhatsApp.',
        });
      }
      let resultado;
      try {
        resultado = await desconectarNumero(c, {
          tenantId: actor.tenantId,
          accountId: id,
          requestId: request.requestId,
        });
      } catch (err) {
        throw new BadRequestException({
          code: 'DISCONNECT_REJECTED',
          message: (err as Error).message,
        });
      }
      await writeAudit(c, {
        tenantId: actor.tenantId,
        actor: actor.userId,
        actorKind: 'user',
        action: 'channel.disconnected',
        resource: 'channel_account',
        resourceId: id,
        result: 'ok',
        metadata: { kind: cuenta.kind, senderId: cuenta.config.senderId ?? null },
        requestId: request.requestId,
      });
      return resultado;
    });
  }

  @Post('whatsapp/numbers/:id/resume')
  @RequirePermission('channels.manage')
  @ApiOperation({ summary: 'Reactiva los envíos del negocio tras una pausa por calidad' })
  async resume(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    try {
      await withTenant(pool(), actor.tenantId, (c) =>
        resumeBusinessSends(c, { tenantId: actor.tenantId, numberId: id, requestId: request.requestId }),
      );
    } catch (err) {
      throw new BadRequestException({ code: 'RESUME_REJECTED', message: (err as Error).message });
    }
    return { resumed: true };
  }
}

/**
 * El cuerpo para crear un widget (#524).
 *
 * El mensaje va escrito acá porque lo lee el dueño del negocio pegando su
 * chat en el sitio, no quien programa: zod por su cuenta diría «Required».
 */
const NuevoWidget = z.object({
  allowedDomain: textoRequerido('Dinos el dominio del sitio donde vivirá el chat.'),
  name: z.string().optional(),
  welcomeMessage: z.string().optional(),
});

/** Administración del webchat (#46): widgets y su snippet. */
@ApiTags('channels')
@Controller('webchat/widgets')
@RequireModule('webchat')
export class WebchatAdminController {
  @Get()
  @RequirePermission('webchat.manage')
  @ApiOperation({ summary: 'Widgets del webchat' })
  async list(@Req() request: WithUser) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) => listWidgets(c, actor.tenantId));
  }

  @Post()
  @RequirePermission('webchat.manage')
  @ApiOperation({ summary: 'Crea un widget para un dominio' })
  async create(
    @Req() request: WithUser,
    @Cuerpo(NuevoWidget) body: z.infer<typeof NuevoWidget>,
  ) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) =>
      createWidget(c, {
        tenantId: actor.tenantId,
        // Ya viene sin espacios: el dominio se guarda tal cual y después se
        // compara contra el del navegador, donde un espacio de más no calza.
        allowedDomain: body.allowedDomain,
        name: body.name,
        welcomeMessage: body.welcomeMessage,
      }),
    );
  }

  @Post(':id/toggle')
  @RequirePermission('webchat.manage')
  @ApiOperation({ summary: 'Activa o desactiva el widget (el historial queda)' })
  async toggle(@Req() request: WithUser, @Param('id') id: string, @Body() body: { active?: boolean }) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) =>
      setWidgetActive(c, { tenantId: actor.tenantId, widgetId: id, active: Boolean(body?.active) }),
    );
  }
}
