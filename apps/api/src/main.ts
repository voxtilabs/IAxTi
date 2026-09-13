import './instrument';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { redisConnection } from '@iaxti/core';
import { createPool } from '@iaxti/db';
import { AppModule, registry } from './app.module';
import { supabaseJwtVerifier, type JwtVerifier } from './auth/jwt';
import { dbRoleResolver, type RoleResolver } from './auth/role-resolver';
import { AuthzGuard } from './authz/authz.guard';
import { ErrorsFilter } from './errors.filter';
import { RateLimitGuard } from './rate-limit.guard';
import { requestIdMiddleware } from './request-id';

export interface CreateAppOptions {
  rateLimitPerMinute?: number;
  jwtVerify?: JwtVerifier | null;
  resolveRole?: RoleResolver | null;
}

export async function createApp(options: CreateAppOptions = {}): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { logger: ['warn', 'error'] });
  app.use(requestIdMiddleware);
  // /v1 en la ruta (SPEC §28); health queda fuera para Dokploy/Uptime Kuma.
  app.setGlobalPrefix('v1', { exclude: ['health', 'ready', 'health/modules'] });
  app.useGlobalFilters(new ErrorsFilter());

  // Rate limiting por tenant/API key (SPEC §28); requiere Redis configurado.
  if (process.env.REDIS_URL || options.rateLimitPerMinute !== undefined) {
    app.useGlobalGuards(new RateLimitGuard(redisConnection(), options.rateLimitPerMinute));
  }
  // Autorización (ADR-0008): módulo activo + permiso del rol. Identidad:
  // JWT de Supabase (JWKS/ES256) con rol desde user_roles; headers como
  // fallback de desarrollo hasta hardening.
  const jwtVerify = options.jwtVerify !== undefined ? options.jwtVerify : supabaseJwtVerifier();
  const resolveRole =
    options.resolveRole !== undefined
      ? options.resolveRole
      : process.env.DATABASE_URL
        ? dbRoleResolver(createPool())
        : null;
  app.useGlobalGuards(new AuthzGuard(app.get(Reflector), registry, { jwtVerify, resolveRole }));

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
