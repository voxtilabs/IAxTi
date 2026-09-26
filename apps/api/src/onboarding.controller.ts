import { Controller, Get, Req, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { withTenant } from '@iaxti/db';
import { onboardingStatus, type EstadoOnboarding, type Verificador } from '@iaxti/module-organizations';
import { listChannelAccounts } from '@iaxti/module-channels';
import { listSources } from '@iaxti/module-knowledge';
import { listarEquipo, listarInvitaciones } from '@iaxti/module-identity';
import { listPipelines } from '@iaxti/module-crm';
import { huboAlgunaConversacion } from '@iaxti/module-conversations';
import type { PoolClient } from 'pg';
import { RequirePermission } from './authz/decorators';
import type { Actor, WithUser } from './authz/authz.guard';
import { apiPool } from './db';
import { registry } from './registry';

const actorOf = (request: WithUser): Actor => request.actor as Actor;

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

/**
 * Los verificadores: cada paso lo responde SU módulo, por contrato.
 *
 * Acá es el único lugar que puede armar esto, porque es el único que conoce
 * todos los contratos. `organizations` recibe las funciones ya hechas y no
 * consulta ninguna tabla ajena.
 *
 * Un módulo apagado no aporta verificador: el paso queda `bloqueado` y el
 * estado lo dice, en vez de mostrarse como pendiente para siempre sobre algo
 * que este tenant no puede hacer.
 */
function verificadores(client: PoolClient, tenantId: string): Partial<Record<string, Verificador>> {
  const si = (id: string) => registry.isActive(id);
  return {
    ...(si('crm')
      ? {
          configured: async () => {
            const pipelines = await listPipelines(client, tenantId);
            const etapas = pipelines.reduce((a, p) => a + (p.stages?.length ?? 0), 0);
            return {
              hecho: pipelines.length > 0,
              detalle: pipelines.length
                ? `${pipelines.length} embudo${pipelines.length > 1 ? 's' : ''} con ${etapas} etapas`
                : 'todavía no hay embudo',
            };
          },
        }
      : {}),
    ...(si('channels')
      ? {
          // El paso se llama whatsapp_connected y significa eso: un número
          // de WhatsApp activo. El webchat y el simulador no cuentan, por
          // más que también sean "canales conectados".
          whatsapp_connected: async () => {
            const cuentas = await listChannelAccounts(client, tenantId);
            const wa = cuentas.filter((c) => c.kind === 'whatsapp');
            const activas = wa.filter((c) => c.state === 'active');
            return {
              hecho: activas.length > 0,
              detalle: activas.length
                ? `${activas.length} número${activas.length > 1 ? 's' : ''} activo${activas.length > 1 ? 's' : ''}`
                : wa.length
                  ? 'el número está conectado pero no activo'
                  : 'todavía no hay número conectado',
            };
          },
        }
      : {}),
    ...(si('knowledge')
      ? {
          knowledge_added: async () => {
            const fuentes = await listSources(client, tenantId);
            return {
              hecho: fuentes.length > 0,
              detalle: fuentes.length ? `${fuentes.length} fuente${fuentes.length > 1 ? 's' : ''}` : 'sin catálogo',
            };
          },
        }
      : {}),
    ...(si('conversations')
      ? {
          // El paso obligatorio que NO tenía verificador (#495): salía
          // siempre del historial de la columna, que no retrocede. O sea que
          // el producto podía mostrar ese check en verde sobre un negocio
          // que jamás recibió un mensaje, y jamás podía aparecer como
          // desfase. Lo encontró el mapeo del propio código.
          first_message: async () => {
            const { conversaciones, ultimoMensajeEl } = await huboAlgunaConversacion(client, tenantId);
            return {
              hecho: conversaciones > 0,
              detalle: conversaciones
                ? `${conversaciones} conversación${conversaciones > 1 ? 'es' : ''}` +
                  (ultimoMensajeEl ? `, la última el ${ultimoMensajeEl.toISOString().slice(0, 10)}` : '')
                : 'todavía no llega ningún mensaje',
            };
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
            // Con el dueño solo no hay equipo: invitar es traer a alguien más.
            const otros = Math.max(equipo.length - 1, 0) + invitaciones.length;
            return {
              hecho: otros > 0,
              detalle: otros ? `${otros} además de ti` : 'por ahora estás tú solo',
            };
          },
        }
      : {}),
  };
}

/**
 * Dónde va el negocio en su puesta en marcha (#56, SPEC §7).
 *
 * Es de lectura y responde con lo que HAY, no solo con lo que la columna
 * `onboarding_state` recuerda. Los dos números importan y son distintos: la
 * columna no retrocede por diseño, así que un paso marcado de más se queda
 * marcado para siempre — y el flujo guiado deja de pedirlo. `desfase` es
 * justamente eso: lo que figura hecho y hoy no está.
 */
@ApiTags('onboarding')
@Controller('onboarding')
export class OnboardingController {
  @Get()
  @RequirePermission('tenant.settings')
  @ApiOperation({ summary: 'En qué paso va la puesta en marcha y qué falta' })
  async estado(@Req() request: WithUser): Promise<EstadoOnboarding> {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) =>
      onboardingStatus(c, actor.tenantId, {
        activeModules: registry
          .health()
          .filter((m) => m.active)
          .map((m) => m.id),
        verificadores: verificadores(c, actor.tenantId),
      }),
    );
  }
}
