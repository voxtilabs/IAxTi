import './instrument';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { redisConnection } from '@iaxti/core';
import { createPool } from '@iaxti/db';
import { AppModule, registry } from './app.module';
import { supabaseJwtVerifier, type JwtVerifier } from './auth/jwt';
import { dbPlatformAdminResolver, dbRoleResolver, type RoleResolver } from './auth/role-resolver';
import { AuthzGuard } from './authz/authz.guard';
import { ErrorsFilter } from './errors.filter';
import { RateLimitGuard } from './rate-limit.guard';
import { requestIdMiddleware } from './request-id';
import { getProvider, registerProvider, simuladorProvider } from '@iaxti/module-channels';

export interface CreateAppOptions {
  rateLimitPerMinute?: number;
  jwtVerify?: JwtVerifier | null;
  resolveRole?: RoleResolver | null;
  resolvePlatformAdmin?: ((userId: string) => Promise<boolean>) | null;
}

export async function createApp(options: CreateAppOptions = {}): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['warn', 'error'],
    // Los webhooks verifican la firma sobre el cuerpo CRUDO (#41).
    rawBody: true,
  });
  // El CSV de importación (#34) viaja en el body: 2 MB alcanzan para miles
  // de filas sin abrir la puerta a payloads absurdos.
  app.useBodyParser('json', { limit: '2mb' });
  // Adaptadores de canal (#41): el simulador es el primero; Kapso llega en #42.
  if (!getProvider('simulador')) registerProvider(simuladorProvider);
  app.use(requestIdMiddleware);
  // El navegador (web/admin) llama a la API desde otro origen: CORS explícito.
  // En producción CORS_ORIGINS es una lista cerrada; sin la variable (dev,
  // e2e) se refleja el origen. Los webhooks y la API por token no usan CORS.
  const origins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({
    origin: origins.length > 0 ? origins : true,
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'X-Tenant-Id',
      'X-Request-Id',
      'X-Api-Key',
      'Idempotency-Key',
    ],
    exposedHeaders: ['X-Request-Id'],
    maxAge: 86_400,
  });
  // /v1 en la ruta (SPEC §28); health queda fuera para Dokploy/Uptime Kuma.
  app.setGlobalPrefix('v1', {
    exclude: ['health', 'ready', 'health/modules', 'webhooks/channels/:accountId'],
  });
  app.useGlobalFilters(new ErrorsFilter());

  // Rate limiting por tenant/API key (SPEC §28); requiere Redis configurado.
  if (process.env.REDIS_URL || options.rateLimitPerMinute !== undefined) {
    app.useGlobalGuards(new RateLimitGuard(redisConnection(), options.rateLimitPerMinute));
  }
  // Autorización (ADR-0008): módulo activo + permiso del rol. Identidad:
  // JWT de Supabase (JWKS/ES256) con rol desde user_roles; headers como
  // fallback de desarrollo hasta hardening.
  const jwtVerify = options.jwtVerify !== undefined ? options.jwtVerify : supabaseJwtVerifier();
  const pool = process.env.DATABASE_URL ? createPool() : null;
  const resolveRole =
    options.resolveRole !== undefined ? options.resolveRole : pool ? dbRoleResolver(pool) : null;
  const resolvePlatformAdmin =
    options.resolvePlatformAdmin !== undefined
      ? options.resolvePlatformAdmin
      : pool
        ? dbPlatformAdminResolver(pool)
        : null;
  app.useGlobalGuards(
    new AuthzGuard(app.get(Reflector), registry, { jwtVerify, resolveRole, resolvePlatformAdmin }),
  );

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
