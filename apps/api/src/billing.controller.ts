import { Body, Controller, Get, Post, Req, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { withTenant } from '@iaxti/db';
import { exportarTenant, getPlanLimits } from '@iaxti/module-organizations';
import { conversacionesPorPeriodo } from '@iaxti/module-conversations';
import {
  cancelarSuscripcion,
  costosDelCicloEnCurso,
  ensureSubscription,
  listInvoices,
} from '@iaxti/module-billing';
import { costThisCycle } from '@iaxti/module-agents';
import { RequireModule, RequirePermission } from './authz/decorators';
import { registry } from './registry';
import type { Actor, WithUser } from './authz/authz.guard';
import { apiPool } from './db';

// billing (#67, SPEC §20): el dueño ve su plan, el próximo cobro y las
// facturas con los TRES costos separados. La boleta/factura electrónica
// se emite a mano con estos datos (v1 documentado); proveedor en v3.

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

@ApiTags('billing')
@Controller('billing')
@RequireModule('billing')
export class BillingController {
  /**
   * Cancelar en un clic (SPEC §6).
   *
   * «Con exportación completa antes» no es una recomendación al frontend:
   * acá la exportación se GENERA primero, en la misma transacción, y su
   * resumen queda en el audit junto a la cancelación. Así no existe la
   * posibilidad de cancelar sin que el negocio tenga cómo llevarse lo suyo.
   *
   * La respuesta trae la exportación entera: es el archivo que el cliente se
   * lleva, y pedirlo de nuevo después de cancelar sería pedirle que confíe.
   */
  @Post('cancelar')
  @RequirePermission('billing.manage')
  @ApiOperation({ summary: 'Cancela la suscripción y entrega la exportación completa' })
  async cancelar(@Req() request: WithUser, @Body() body: { motivo?: string }) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      const exportacion = await exportarTenant(c, { tenantId: actor.tenantId });
      const filas = Object.values(exportacion.resumen).reduce((a: number, b: number) => a + b, 0);
      const { cancelAt } = await cancelarSuscripcion(c, {
        tenantId: actor.tenantId,
        actor: actor.userId,
        motivo: body?.motivo,
        exportacion: { filas, generadoEl: exportacion.generadoEl },
        requestId: (request as { requestId?: string }).requestId,
      });
      return {
        cancelAt,
        mensaje:
          `Tu cuenta queda activa hasta el ${cancelAt}. Después pasa a solo lectura: ` +
          'tus conversaciones y contactos siguen ahí, pero no se envían mensajes.',
        exportacion,
      };
    });
  }

  @Get()
  @RequirePermission('billing.read')
  @ApiOperation({ summary: 'La suscripción y las facturas del tenant' })
  async billing(@Req() request: WithUser) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      const subscription = await ensureSubscription(c, actor.tenantId);
      const invoices = await listInvoices(c, actor.tenantId);
      // Lo que va a salir ESTE ciclo, mirado hoy (SPEC §40).
      //
      // «Costos visibles: Meta e IA por tenant en tiempo real, en pesos, sin
      // margen escondido». Estaba escrito y no se podía cumplir: el costo de
      // Meta solo se calculaba al emitir la factura, así que el dueño veía lo
      // que gastó cuando ya se lo habían cobrado — justo cuando deja de poder
      // hacer algo al respecto.
      //
      // Los dos costos viven en módulos distintos y se juntan ACÁ, que es el
      // único lugar que conoce los dos contratos. `billing` no consulta las
      // tablas de `agents` ni al revés.
      const cicloEnCurso = await costosDelCicloEnCurso(c, actor.tenantId);
      const iaUsd = await costThisCycle(c, actor.tenantId);
      const rate = cicloEnCurso?.usdClpRate ?? 950;
      // El consumo desglosado (#702).
      //
      // `.claude/rules/negocio.md` pide «costos visibles, sin margen escondido»:
      // un contador que no se puede abrir no es verificable, ni por el cliente
      // ni por nosotros. El desglose sale de `conversations.usage_period` —la
      // marca que hace que cada conversación se cuente una sola vez— y el tope
      // del plan, de `organizations`. Se juntan ACÁ por la misma razón que los
      // dos costos de arriba: es el único lugar que conoce los dos contratos.
      //
      // Se degrada si `conversations` está apagado para el tenant: la pantalla
      // de facturación no puede caerse porque un módulo opcional no esté.
      const limites = await getPlanLimits(c, subscription.plan).catch(() => null);
      const porPeriodo = registry.isActive('conversations')
        ? await conversacionesPorPeriodo(c, actor.tenantId)
        : [];
      return {
        subscription,
        invoices,
        consumo: porPeriodo.map((p) => ({
          ...p,
          tope: limites?.conversationsMonth ?? null,
          // El plan es el VIGENTE, y el ciclo va completo: el medidor cuenta
          // conversaciones activas del ciclo, no del plan, y partir el ciclo al
          // cambiar de plan sería cambiar la definición de la métrica a mitad
          // de camino. La factura de ese ciclo sí dice con qué plan se cobró.
          plan: subscription.plan,
        })),
        cicloEnCurso: cicloEnCurso && {
          ...cicloEnCurso,
          // La IA va aparte y NO suma al total del ciclo: lo que se factura
          // es el plan y el exceso de Meta. Meterla en el mismo número haría
          // creer que se le va a cobrar, y no es así.
          ia: { usd: Number(iaUsd.toFixed(4)), clp: Math.round(iaUsd * rate) },
        },
      };
    });
  }
}
