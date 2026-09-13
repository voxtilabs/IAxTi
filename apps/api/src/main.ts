import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from './app.module';
import { ErrorsFilter } from './errors.filter';
import { requestIdMiddleware } from './request-id';

export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { logger: ['warn', 'error'] });
  app.use(requestIdMiddleware);
  // /v1 en la ruta (SPEC §28); health queda fuera para Dokploy/Uptime Kuma.
  app.setGlobalPrefix('v1', { exclude: ['health', 'ready', 'health/modules'] });
  app.useGlobalFilters(new ErrorsFilter());

  const config = new DocumentBuilder()
    .setTitle('IAxTi API')
    .setDescription(
      'API pública de IAxTi. Errores siempre como { code, message, requestId, details[] }. ' +
        'Paginación por cursor (límite máximo 100). Idempotency-Key en POST que crean o cobran.',
    )
    .setVersion('0.1.0')
    .setOpenAPIVersion('3.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);

  return app;
}

async function bootstrap() {
  const app = await createApp();
  await app.listen(Number(process.env.PORT ?? 3000));
}

if (require.main === module) {
  void bootstrap();
}
