import { Controller, Get, Module, NotFoundException, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ModuleRegistry } from '@iaxti/core';

// El registry se construye una vez al arrancar; una validación fallida
// (ciclo, colisión, dependencia inexistente) aborta el proceso a propósito
// (SPEC §26). Los controllers no llevan lógica: solo exponen el registry.
const registry = new ModuleRegistry().load();

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
class DemoErroresController {
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
}

@Module({ controllers: [HealthController, MeController, DemoErroresController] })
export class AppModule {}
