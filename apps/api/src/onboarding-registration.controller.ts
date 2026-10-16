import { BadRequestException, Controller, Get, HttpCode, Post, Req, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { withTenant } from '@iaxti/db';
import { getTenant, getTenantSettings } from '@iaxti/module-organizations';
import { metaCostThisCycle } from '@iaxti/module-billing';
import { costThisCycle } from '@iaxti/module-agents';
import { registry } from './registry';
import { RequireAuth, RequireModule, RequirePermission } from './authz/decorators';
import type { Actor, WithUser } from './authz/authz.guard';
import { Cuerpo, textoRequerido } from './validar';
import { apiPool } from './db';
import { registerInitialBusiness } from './onboarding-registration';

const Registro = z.strictObject({
  displayName: textoRequerido('Escribe tu nombre.').max(100, 'Tu nombre admite hasta 100 caracteres.'),
  name: textoRequerido('Escribe el nombre de tu negocio.').max(100, 'El nombre admite hasta 100 caracteres.'),
  description: textoRequerido('Cuéntanos a qué se dedica tu negocio.').min(10, 'Cuéntanos un poco más: al menos 10 caracteres.').max(4000, 'La descripción admite hasta 4000 caracteres.'),
  vertical: z.enum(['belleza', 'salud', 'inmobiliaria', 'retail', 'servicios', 'otro'], { error: 'Elige el rubro de tu negocio.' }),
});

function pool() {
  const result = apiPool();
  if (!result) throw new ServiceUnavailableException({ code: 'DB_NOT_CONFIGURED', message: 'No pudimos abrir tu negocio. Intenta más tarde.' });
  return result;
}

@ApiTags('onboarding')
@Controller('onboarding')
@RequireModule('organizations')
export class OnboardingRegistrationController {
  // Antes de tener un tenant no existe tenant.settings. Esta puerta exige JWT
  // incluso en desarrollo: cookies, API keys y X-User-Id nunca crean negocios.
  @Post('registro')
  @HttpCode(200)
  @RequireAuth({ jwtOnly: true })
  @ApiOperation({ summary: 'Crea una sola vez el negocio inicial de la sesión' })
  async register(@Req() request: WithUser, @Cuerpo(Registro) body: z.infer<typeof Registro>) {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !key.trim() || key.length > 255) {
      throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'No pudimos identificar este intento. Actualiza la página y vuelve a probar.' });
    }
    return registerInitialBusiness(pool(), {
      ...body, userId: request.user!.userId, requestId: request.requestId,
    });
  }

  @Get('negocio')
  @RequirePermission('tenant.settings')
  @ApiOperation({ summary: 'Descripción y prueba del negocio para retomar la puesta en marcha' })
  async business(@Req() request: WithUser) {
    const actor = request.actor as Actor;
    return withTenant(pool(), actor.tenantId, async (client) => {
      const tenant = await getTenant(client, actor.tenantId);
      const settings = await getTenantSettings(client, actor.tenantId);
      return {
        name: tenant.name, vertical: tenant.rubro ?? 'otro',
        description: typeof settings.businessDescription === 'string' ? settings.businessDescription : '',
        plan: tenant.plan, state: tenant.state, trialEndsAt: tenant.trialEndsAt,
      };
    });
  }

  @Get('costos')
  @RequireModule('billing')
  @RequirePermission('tenant.billing')
  @ApiOperation({ summary: 'Consumo registrado de Meta e IA sin crear cobros ni suscripción' })
  async costs(@Req() request: WithUser) {
    const actor = request.actor as Actor;
    return withTenant(pool(), actor.tenantId, async (client) => {
      const meta = await metaCostThisCycle(client, actor.tenantId);
      const iaUsd = registry.isActive('agents') ? await costThisCycle(client, actor.tenantId) : null;
      return { cicloEnCurso: { ...meta, ia: iaUsd === null ? null : { usd: iaUsd, clp: Math.round(iaUsd * meta.usdClpRate) } } };
    });
  }
}
