import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { degradarSinRomper, withTenant } from '@iaxti/db';
import {
  diagnosticarCanal,
  findAccountById,
  listChannelAccounts,
  cupoDelDia,
} from '@iaxti/module-channels';
import { salientesDelDia } from '@iaxti/module-conversations';
import { writeAudit } from '@iaxti/module-audit';
import {
  desconectarNumero,
  cuentaEnZernio,
  baseDeZernio,
  listTemplates,
  listWhatsAppNumbers,
  resumeBusinessSends,
} from '@iaxti/module-whatsapp';
import { createWidget, listWidgets, setWidgetActive } from '@iaxti/module-webchat';
import { z } from 'zod';
import { RequireModule, RequirePermission } from './authz/decorators';
import { Cuerpo, textoRequerido } from './validar';
import type { Actor, WithUser } from './authz/authz.guard';
import { apiPool, apiRedis } from './db';
import { CUERPO_DE_PRUEBA, probarEnvio } from './probar-envio';

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
 * El cuerpo de la prueba de envío (#587).
 *
 * Solo el teléfono: el texto NO lo elige quien prueba. Es
 * `CUERPO_DE_PRUEBA`, dice que es una prueba de IAxTi y de dónde viene —
 * quien lo recibe tiene que entender por qué le llegó— y dejar el texto
 * abierto convertiría esto en un formulario para mandar lo que sea desde el
 * número del negocio, sin pasar por la bandeja ni quedar en la conversación.
 */
const PruebaDeEnvio = z.object({
  telefono: textoRequerido('Dinos a qué número mandar la prueba, en formato +56912345678.'),
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
  @ApiQuery({ name: 'archivados', required: false, description: '1 para incluir los canales archivados' })
  async list(@Req() request: WithUser, @Query('archivados') archivados?: string) {
    const actor = actorOf(request);
    /**
     * Los archivados NO salen, salvo que se pidan (#1202).
     *
     * Mostraban su diagnóstico en rojo —«El canal está disconnected · Vuelve a
     * conectarlo»— al lado del que sí anda. Correcto como descripción y
     * equivocado como consejo: nadie quiere reconectar lo que archivó, y dos
     * rojos permanentes impiden distinguir un problema de la historia.
     *
     * Se pueden pedir porque nada se borra: se archiva, y lo archivado se tiene
     * que poder mirar.
     */
    const incluirDesconectados = archivados === '1';
    return withTenant(pool(), actor.tenantId, async (c) => {
      // Los números son opcionales —la pantalla se dibuja igual sin ellos—
      // pero la cuenta de canal NO: sin ella no hay nada que mostrar. Por eso
      // una se degrada y la otra no, y por eso la que se degrada va dentro de
      // un savepoint: si no, su fallo se lleva puesta la otra (#962, #966).
      const [accounts, numbers] = await Promise.all([
        listChannelAccounts(c, actor.tenantId, { incluirDesconectados }),
        degradarSinRomper(
          c,
          (cl) => listWhatsAppNumbers(cl, actor.tenantId),
          (error) => {
            console.warn(
              `channels: no se pudieron leer los números de WhatsApp de ${actor.tenantId}; ` +
                `las cuentas salen sin ellos. Causa: ${error.message}`,
            );
            return [];
          },
        ),
      ]);
      /*
       * El cupo diario del canal, para que se vea venir (#1248).
       *
       * El 3 de noviembre el pulso del evento gastó 182 mensajes sobre 91
       * entrantes y al cerrar el stand los 31 de despedida fallaron todos. El
       * cupo se consumió a lo largo de seis horas y el producto no lo dijo en
       * ningún momento: el dueño se enteró cuando lo importante no salió.
       *
       * En SERIE y no en `Promise.all`: todas estas consultas comparten un
       * solo `PoolClient`, y meter varias en paralelo sobre el mismo cliente
       * fue exactamente lo que dejó invisible el aviso de retención en #1078.
       *
       * Y degradado como los números: si el conteo falla, el canal se muestra
       * igual sin él. Saber el cupo es útil; no saberlo no puede impedir ver
       * si el canal está conectado.
       */
      const cupos = new Map<string, unknown>();
      for (const a of accounts) {
        if (a.kind !== 'whatsapp') continue;
        try {
          cupos.set(
            a.id,
            cupoDelDia({
              enviados: await salientesDelDia(c, {
                tenantId: actor.tenantId,
                channelAccountId: a.id,
              }),
              config: a.config as Record<string, unknown>,
            }),
          );
        } catch (error) {
          console.warn(
            `channels: no se pudo contar el cupo del día de ${a.id}; el canal sale sin él. ` +
              `Causa: ${(error as Error).message}`,
          );
        }
      }

      return accounts.map((a) => ({
        ...a,
        numbers: numbers.filter((n) => n.channelAccountId === a.id),
        ...(cupos.has(a.id) ? { cupoDelDia: cupos.get(a.id) } : {}),
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
                  // Se le pregunta al proveedor DE LA CUENTA (#1321). Antes
                  // esto llamaba siempre a Zavu, y con una cuenta de Zernio
                  // abrir el diagnóstico le mandaba la llave de Zernio a Zavu.
                  // Zavu se fue (#1339); la regla se queda: cada llave habla
                  // con su propio proveedor, y el que venga hereda el chequeo.
                  if (cuenta.provider !== 'zernio') return null;
                  const { zernioAccountId, zernioProfileId } = cuenta.config;
                  if (typeof zernioAccountId !== 'string' || typeof zernioProfileId !== 'string') return null;
                  return cuentaEnZernio(
                    { apiKey, apiBase: baseDeZernio(), fetchImpl: (...a) => globalThis.fetch(...a) },
                    { profileId: zernioProfileId, zernioAccountId },
                  );
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

  /**
   * Manda un mensaje de prueba por el camino real y cuenta qué pasó (#587).
   *
   * El tope: una prueba por canal cada cinco minutos. No es por costo —un
   * mensaje no cuesta nada— es porque esto manda un WhatsApp a una persona de
   * verdad, y un botón que se puede apretar diez veces seguidas le llena el
   * teléfono a alguien. Si Redis no está, la prueba igual sale: el tope es una
   * cortesía, no una cerradura, y cambiar «no puedo diagnosticar» por «no
   * tengo Redis» sería el peor negocio posible justo en la herramienta que
   * existe para desatascar.
   */
  @Post('channels/:id/probar-envio')
  @RequireModule('whatsapp')
  @RequirePermission('channels.manage')
  @ApiOperation({ summary: 'Manda un mensaje de prueba por este canal y dice exactamente qué pasó' })
  async probar(
    @Req() request: WithUser,
    @Param('id') id: string,
    @Cuerpo(PruebaDeEnvio) body: z.infer<typeof PruebaDeEnvio>,
  ) {
    const actor = actorOf(request);
    const redis = apiRedis();
    const clave = `prueba-envio:${actor.tenantId}:${id}`;
    if (redis) {
      try {
        // `NX` + `EX`: la marca se pone solo si no estaba, en una sola
        // operación. Con un `get` y después un `set`, dos clics simultáneos
        // pasan los dos.
        const puso = await redis.set(clave, '1', 'EX', 300, 'NX');
        if (puso === null) {
          throw new BadRequestException({
            code: 'TEST_SEND_TOO_SOON',
            message:
              'Ya probaste este canal hace menos de cinco minutos. La prueba le llega a una ' +
              'persona de verdad, así que espera un rato antes de repetirla.',
          });
        }
      } catch (err) {
        // Un Redis caído no puede impedir diagnosticar; el `BadRequest` de
        // arriba sí tiene que salir.
        if (err instanceof BadRequestException) throw err;
      }
    }
    const resultado = await probarEnvio(
      { pool: pool(), redis },
      {
        tenantId: actor.tenantId,
        accountId: id,
        telefono: body.telefono,
        requestId: request.requestId,
      },
    );
    // El tope se DEVUELVE cuando no se llegó a enviar nada (#773).
    //
    // El candado se pone antes de llamar, porque es lo que impide que dos clics
    // simultáneos manden dos mensajes. Pero si la prueba se rechazó por una
    // regla —un teléfono mal escrito, la ventana cerrada, el silencio— no salió
    // ningún WhatsApp, y dejar el candado puesto deja a la persona cinco
    // minutos sin poder volver a intentar. El tope existe para no llenarle el
    // teléfono a alguien, no para castigar un error de tipeo.
    if (redis && !resultado.ok) {
      await redis.del(clave).catch(() => undefined);
    }
    // Se audita SIEMPRE, salga o no: a quién se le mandó —o a quién se intentó
    // mandar— desde el número del negocio es justo lo que alguien va a querer
    // reconstruir después. El cuerpo no va: es fijo y está en el código.
    await withTenant(pool(), actor.tenantId, (c) =>
      writeAudit(c, {
        tenantId: actor.tenantId,
        actor: actor.userId,
        actorKind: actor.kind === 'soporte' ? 'superadmin' : actor.kind ?? 'user',
        action: 'channel.test_send',
        resource: 'channel_account',
        resourceId: id,
        result: resultado.ok ? 'ok' : 'denied',
        metadata: {
          telefono: body.telefono,
          motivo: resultado.motivo,
          ...(resultado.providerMessageId ? { providerMessageId: resultado.providerMessageId } : {}),
        },
        requestId: request.requestId,
      }),
    );
    return { ...resultado, cuerpo: CUERPO_DE_PRUEBA };
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
