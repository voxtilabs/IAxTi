import { Controller, Get, Module } from '@nestjs/common';
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

@Module({ controllers: [HealthController] })
export class AppModule {}
