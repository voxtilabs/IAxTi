import { Controller, Get, Req, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { withTenant } from '@iaxti/db';
import { ensureSubscription, listInvoices } from '@iaxti/module-billing';
import { RequireModule, RequirePermission } from './authz/decorators';
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
  @Get()
  @RequirePermission('billing.read')
  @ApiOperation({ summary: 'La suscripción y las facturas del tenant' })
  async billing(@Req() request: WithUser) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      const subscription = await ensureSubscription(c, actor.tenantId);
      const invoices = await listInvoices(c, actor.tenantId);
      return { subscription, invoices };
    });
  }
}
