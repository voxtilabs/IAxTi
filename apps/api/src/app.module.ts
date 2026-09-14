import {
  Controller,
  Get,
  Module,
  NotFoundException,
  Param,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ModuleRegistry } from '@iaxti/core';
import { tenantsOf } from '@iaxti/module-identity';
import { RequireAuth, RequireModule, RequirePermission } from './authz/decorators';
import type { WithUser } from './authz/authz.guard';
import { apiPool } from './db';

// El registry se construye una vez al arrancar; una validación fallida
// (ciclo, colisión, dependencia inexistente) aborta el proceso a propósito
// (SPEC §26). Los controllers no llevan lógica: solo exponen el registry.
export const registry = new ModuleRegistry().load();

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

@Module({ controllers: [HealthController, MeController, DemoController] })
export class AppModule {}
