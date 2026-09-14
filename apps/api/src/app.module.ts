import {
  Controller,
  Get,
  Module,
  NotFoundException,
  Param,
  Req,
  ServiceUnavailableException,
  Put,
  Body,
  BadRequestException,
  Post,
  Delete,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { tenantsOf } from '@iaxti/module-identity';
import {
  adminChangePlan,
  adminCreateTenant,
  adminExtendTrial,
  adminSetTenantState,
  endSupportSession,
  listTenants,
  startSupportSession,
  supportStatus,
  tenantDetail,
} from '@iaxti/module-platform';
import { RequireAuth, RequireModule, RequirePermission } from './authz/decorators';
import type { WithUser } from './authz/authz.guard';
import { apiPool } from './db';
import { withTenant } from '@iaxti/db';
import { registry } from './registry';
import { SimuladorController } from './simulador.controller';
import { ConversationsController } from './conversations.controller';
import { SettingsController } from './settings.controller';
import { EquipoController, QuickRepliesController } from './equipo.controller';
import { ContactsController } from './contacts.controller';
import { DealsController } from './deals.controller';
import { WebhooksController } from './webhooks.controller';
import { ChannelsController, WebchatAdminController } from './channels.controller';
import { WebchatController } from './webchat.controller';
import { NotificationsController } from './notifications.controller';
import { AgentsController } from './agents.controller';
import { KnowledgeController } from './knowledge.controller';
import { AutomationsController } from './automations.controller';
import { AnalyticsController } from './analytics.controller';
import { ApiUsageController } from './api-usage.controller';
import { ApiKeysController } from './apikeys.controller';
import { WebhooksSalientesController } from './webhooks-salientes.controller';
import { RolesController } from './roles.controller';
import { PaymentsController, PaymentWebhooksController } from './payments.controller';
import { BillingController } from './billing.controller';

// Los controllers no llevan lógica: solo exponen el registry y los contracts.
export { registry };

@Controller()
class HealthController {
  @Get('health')
  health() {
    return { status: 'ok', service: 'api' };
  }

  @Get('ready')
  ready() {
    return { status: 'ok', service: 'api' };
  }

  @Get('health/modules')
  modules() {
    return registry.health();
  }
}

@ApiTags('me')
@Controller('me')
class MeController {
  /**
   * Quién soy y a qué negocios pertenezco: lo primero que pide el shell
   * tras el login, para el selector de tenant (SPEC §9: un usuario puede
   * estar en varios tenants con roles distintos).
   */
  @Get()
  @RequireAuth()
  @ApiOperation({ summary: 'Usuario de la sesión y sus negocios' })
  async me(@Req() request: WithUser) {
    const pool = apiPool();
    if (!pool) {
      throw new ServiceUnavailableException({
        code: 'DB_NOT_CONFIGURED',
        message: 'El servidor aún no tiene base de datos configurada. Intenta más tarde.',
      });
    }
    const user = request.user as { userId: string; email?: string };
    const client = await pool.connect();
    try {
      const tenants = await tenantsOf(client, user.userId);
      return { userId: user.userId, email: user.email ?? null, tenants };
    } finally {
      client.release();
    }
  }

  /**
   * El frontend arma navegación y widgets desde aquí: un módulo apagado
   * desaparece sin desplegar (SPEC §26 regla 5). El filtro por plan del
   * tenant se suma cuando exista autenticación (#7/#9).
   */
  @Get('modules')
  @ApiOperation({ summary: 'Módulos activos con su navegación y widgets' })
  modules() {
    return registry
      .health()
      .filter((m) => m.active)
      .map((m) => {
        const manifest = registry.manifest(m.id);
        return {
          id: m.id,
          nav: manifest.nav ?? [],
          widgets: manifest.widgets ?? [],
        };
      });
  }
}

@ApiTags('platform')
@Controller('platform')
class PlatformController {
  /** Lista read-only para el SuperAdmin (SPEC §22). Mutaciones llegan con #68. */
  @Get('tenants')
  @RequireModule('platform')
  @RequirePermission('platform.tenants')
  @ApiOperation({ summary: 'Tenants de la plataforma (solo lectura)' })
  async tenants() {
    const pool = apiPool();
    if (!pool) {
      throw new ServiceUnavailableException({
        code: 'DB_NOT_CONFIGURED',
        message: 'El servidor aún no tiene base de datos configurada. Intenta más tarde.',
      });
    }
    const client = await pool.connect();
    try {
      return await listTenants(client);
    } finally {
      client.release();
    }
  }

  /** El SuperAdmin sube o baja la cuota mensual de API de UN tenant (#25)
   *  sin desplegar: settings.api.requestsMonthOverride. */
  @Put('tenants/:id/api-quota')
  @RequireModule('platform')
  @RequirePermission('platform.plans')
  @ApiOperation({ summary: 'Override de cuota mensual de API por tenant' })
  async apiQuota(@Param('id') id: string, @Body() body: { requestsMonth?: number | null }) {
    const pool = apiPool();
    if (!pool) {
      throw new ServiceUnavailableException({
        code: 'DB_NOT_CONFIGURED',
        message: 'El servidor aún no tiene base de datos configurada. Intenta más tarde.',
      });
    }
    const valor = body?.requestsMonth ?? null;
    if (valor !== null && !(Number(valor) > 0)) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'La cuota es un número positivo, o null para volver al plan.',
      });
    }
    await withTenant(pool, id, (c) =>
      c.query(
        `UPDATE tenants SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{api}',
           COALESCE(settings->'api', '{}'::jsonb) || jsonb_build_object('requestsMonthOverride', $2::numeric))
          WHERE id = $1`,
        [id, valor],
      ),
    );
    return { tenantId: id, requestsMonthOverride: valor };
  }

  /** El dashboard de consumo de API del SuperAdmin (#26): requests del
   *  mes por tenant contra su tope, desde UsageMeter. */
  @Get('api-usage')
  @RequireModule('platform')
  @RequirePermission('platform.plans')
  @ApiOperation({ summary: 'Consumo de API por tenant (mes en curso)' })
  async apiUsage() {
    const pool = apiPool();
    if (!pool) {
      throw new ServiceUnavailableException({
        code: 'DB_NOT_CONFIGURED',
        message: 'El servidor aún no tiene base de datos configurada. Intenta más tarde.',
      });
    }
    const client = await pool.connect();
    try {
      const r = await client.query(
        `SELECT t.id, t.name, t.plan,
                COALESCE(um.value, 0)::int AS used,
                COALESCE((t.settings->'api'->>'requestsMonthOverride')::int, pl.api_requests_month) AS "limit"
           FROM tenants t
           LEFT JOIN plan_limits pl ON pl.plan = t.plan
           LEFT JOIN usage_meters um ON um.tenant_id = t.id AND um.metric = 'api_requests'
                AND um.period_start = date_trunc('month', now())::date
          ORDER BY used DESC, t.name`,
      );
      return r.rows;
    } finally {
      client.release();
    }
  }

  // --- Gestión de tenants (#68): crear, estado, plan, prueba, soporte ---

  @Get('tenants/:id')
  @RequireModule('platform')
  @RequirePermission('platform.tenants')
  @ApiOperation({ summary: 'El detalle operativo: estado, plan, uso y canales' })
  async tenantDetail(@Param('id') id: string) {
    const pool = platformPool();
    const client = await pool.connect();
    try {
      return await tenantDetail(client, id);
    } catch {
      throw new NotFoundException({ code: 'TENANT_NOT_FOUND', message: 'No encontramos ese tenant.' });
    } finally {
      client.release();
    }
  }

  @Post('tenants')
  @RequireModule('platform')
  @RequirePermission('platform.tenants')
  @ApiOperation({ summary: 'Crea un tenant (nace en prueba)' })
  async createTenant(@Req() request: WithUser, @Body() body: { name?: string; plan?: string; rubro?: string }) {
    try {
      return await adminCreateTenant(platformPool(), {
        name: body?.name ?? '',
        plan: body?.plan,
        rubro: body?.rubro,
        adminUser: request.user!.userId,
      });
    } catch (err) {
      throw new BadRequestException({ code: 'TENANT_INVALID', message: (err as Error).message });
    }
  }

  @Post('tenants/:id/state')
  @RequireModule('platform')
  @RequirePermission('platform.tenants')
  @ApiOperation({ summary: 'Suspende o reactiva (máquina de estados §6)' })
  async setState(@Req() request: WithUser, @Param('id') id: string, @Body() body: { action?: string }) {
    if (body?.action !== 'suspend' && body?.action !== 'reactivate') {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'La acción es suspend o reactivate.' });
    }
    try {
      return await adminSetTenantState(platformPool(), {
        tenantId: id,
        action: body.action,
        adminUser: request.user!.userId,
      });
    } catch (err) {
      throw new BadRequestException({ code: 'TENANT_INVALID', message: (err as Error).message });
    }
  }

  @Post('tenants/:id/plan')
  @RequireModule('platform')
  @RequirePermission('platform.tenants')
  @ApiOperation({ summary: 'Cambia el plan — límites del plan aplican al tiro' })
  async setPlan(@Req() request: WithUser, @Param('id') id: string, @Body() body: { plan?: string }) {
    try {
      return await adminChangePlan(platformPool(), {
        tenantId: id,
        plan: body?.plan ?? '',
        adminUser: request.user!.userId,
      });
    } catch (err) {
      throw new BadRequestException({ code: 'TENANT_INVALID', message: (err as Error).message });
    }
  }

  @Post('tenants/:id/extend-trial')
  @RequireModule('platform')
  @RequirePermission('platform.tenants')
  @ApiOperation({ summary: 'Extiende la prueba (1 a 90 días)' })
  async extendTrial(@Req() request: WithUser, @Param('id') id: string, @Body() body: { days?: number }) {
    try {
      return await adminExtendTrial(platformPool(), {
        tenantId: id,
        days: Number(body?.days ?? 0),
        adminUser: request.user!.userId,
      });
    } catch (err) {
      throw new BadRequestException({ code: 'TENANT_INVALID', message: (err as Error).message });
    }
  }

  @Post('tenants/:id/support')
  @RequireModule('platform')
  @RequirePermission('platform.tenants')
  @ApiOperation({ summary: 'Modo soporte: lectura acotada CON aviso al tenant' })
  async support(@Req() request: WithUser, @Param('id') id: string, @Body() body: { hours?: number; reason?: string }) {
    return startSupportSession(platformPool(), {
      tenantId: id,
      adminUser: request.user!.userId,
      hours: body?.hours,
      reason: body?.reason,
    });
  }

  @Delete('tenants/:id/support')
  @RequireModule('platform')
  @RequirePermission('platform.tenants')
  @ApiOperation({ summary: 'Termina el modo soporte' })
  async endSupport(@Req() request: WithUser, @Param('id') id: string) {
    await endSupportSession(platformPool(), { tenantId: id, adminUser: request.user!.userId });
    return { ended: true };
  }
}

/** El AVISO del modo soporte, visible para CUALQUIER miembro del tenant. */
@ApiTags('settings')
@Controller('support-status')
class SupportStatusController {
  @Get()
  @RequirePermission('tenant.read')
  @ApiOperation({ summary: '¿El soporte de IAxTi está mirando esta cuenta?' })
  async status(@Req() request: WithUser) {
    const pool = platformPool();
    const client = await pool.connect();
    try {
      return await supportStatus(client, (request.actor as { tenantId: string }).tenantId);
    } finally {
      client.release();
    }
  }
}

@ApiTags('demo')
@Controller('demo')
class DemoController {
  /** Existe solo para verificar el formato de error único; se retira con el primer recurso real. */
  @Get('no-existe/:id')
  @ApiOperation({ summary: 'Demostración del formato de error' })
  noExiste(@Param('id') id: string): never {
    throw new NotFoundException({
      code: 'CONTACT_NOT_FOUND',
      message: 'No encontramos ese contacto. Puede que se haya eliminado.',
      details: [{ id }],
    });
  }

  /** Demostración del guard de autorización; se retira con el primer recurso real. */
  @Get('protegido')
  @RequireModule('audit')
  @RequirePermission('audit.read')
  @ApiOperation({ summary: 'Demostración de @RequireModule + @RequirePermission' })
  protegido() {
    return { ok: true };
  }
}

// El simulador (#36) existe solo en local y staging: en producción la ruta
// ni se registra (404, no 403). IAXTI_ENV=production la apaga.
function platformPool() {
  const pool = apiPool();
  if (!pool) {
    throw new ServiceUnavailableException({
      code: 'DB_NOT_CONFIGURED',
      message: 'El servidor aún no tiene base de datos configurada. Intenta más tarde.',
    });
  }
  return pool;
}

const controllers = [
  HealthController,
  MeController,
  PlatformController,
  SupportStatusController,
  DemoController,
  ConversationsController,
  SettingsController,
  QuickRepliesController,
  EquipoController,
  ContactsController,
  DealsController,
  WebhooksController,
  ChannelsController,
  WebchatAdminController,
  WebchatController,
  NotificationsController,
  AgentsController,
  KnowledgeController,
  AutomationsController,
  AnalyticsController,
  ApiKeysController,
  ApiUsageController,
  WebhooksSalientesController,
  RolesController,
  PaymentsController,
  PaymentWebhooksController,
  BillingController,
  ...((process.env.IAXTI_ENV ?? 'dev') !== 'production' ? [SimuladorController] : []),
];

@Module({ controllers })
export class AppModule {}
