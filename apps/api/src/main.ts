import './instrument';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { redisConnection } from '@iaxti/core';
import { createPool, exigeRolQueRespetaRls } from '@iaxti/db';
import { AppModule, registry } from './app.module';
import { supabaseJwtVerifier, type JwtVerifier } from './auth/jwt';
import { dbCustomPermissionsResolver, dbPlatformAdminResolver, dbRoleResolver, type RoleResolver } from './auth/role-resolver';
import { registrarRechazo } from './auth/registrar-rechazo';
import { registrarSoporte } from './auth/registrar-soporte';
import { AuthzGuard } from './authz/authz.guard';
import { resolveApiKey } from '@iaxti/module-authorization';
import {
  activeSupportSession,
  applyModuleFlags,
} from '@iaxti/module-platform';
import { ErrorsFilter } from './errors.filter';
import { RateLimitGuard } from './rate-limit.guard';
import { accesoAlModulo, modulosDelPlan, modulosVendibles } from '@iaxti/module-organizations';
import { ApiQuotaGuard } from './api-quota.guard';
import { IdempotenciaInterceptor } from './idempotencia.interceptor';
import { requestIdMiddleware } from './request-id';
import { cabecerasMiddleware } from './cabeceras';
import { getProvider, registerProvider, simuladorProvider } from '@iaxti/module-channels';
import { createZavuProvider } from '@iaxti/module-whatsapp';
import { webchatProvider } from '@iaxti/module-webchat';

export interface CreateAppOptions {
  rateLimitPerMinute?: number;
  jwtVerify?: JwtVerifier | null;
  resolveRole?: RoleResolver | null;
  resolvePlatformAdmin?: ((userId: string) => Promise<boolean>) | null;
  resolveApiKey?: ((token: string) => Promise<{ id: string; tenantId: string; scopes: string[] } | null>) | null;
  /** La sesión de soporte del SUPERADMIN (issue 219); null lo apaga. */
  resolveSupportSession?:
    | ((tenantId: string, userId: string) => Promise<{ id: string } | null>)
    | null;
  /** El acceso por PLAN (issue 209); null lo apaga en tests sin base. */
  resolveAccesoModulo?:
    | ((tenantId: string, moduleId: string) => Promise<'completo' | 'solo_lectura'>)
    | null;
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
  // Adaptadores de canal (#41): el simulador es el primero. Zavu (#42) es UN
  // transporte para tres canales — mismo envelope, misma firma (ADR-0014).
  if (!getProvider('simulador')) registerProvider(simuladorProvider);
  for (const kind of ['whatsapp', 'instagram', 'messenger'] as const) {
    if (!getProvider(kind)) registerProvider(createZavuProvider(kind));
  }
  if (!getProvider('webchat')) registerProvider(webchatProvider);
  app.use(cabecerasMiddleware);
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
    exclude: [
      'health',
      'ready',
      'health/modules',
      'webhooks/channels/:accountId',
      'webhooks/payments/:providerId',
      'webchat/:widgetId/config',
      'webchat/:widgetId/sessions',
      'webchat/:widgetId/messages',
    ],
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
  const resolveApiKeyOpt =
    options.resolveApiKey !== undefined
      ? options.resolveApiKey
      : pool
        ? (token: string) => resolveApiKey(pool, token)
        : null;
  // El aislamiento entre tenants no es negociable (issue 211): si la
  // conexión se salta RLS, esto no arranca. Un 503 más tarde sería peor —
  // mientras tanto estaría sirviendo datos cruzados.
  if (pool) await exigeRolQueRespetaRls(pool);

  // Flags de módulos SIN desplegar (#69): al arrancar y cada 60 s.
  if (pool) {
    void applyModuleFlags(pool, registry).catch(() => {});
    setInterval(() => void applyModuleFlags(pool, registry).catch(() => {}), 60_000).unref?.();
  }
  app.useGlobalGuards(
    new AuthzGuard(app.get(Reflector), registry, {
      jwtVerify,
      resolveRole,
      resolvePlatformAdmin,
      resolveApiKey: resolveApiKeyOpt,
      resolveCustomPermissions: pool ? dbCustomPermissionsResolver(pool) : null,
      // Modo soporte (issue 219): lectura del tenant SOLO con sesión viva.
      resolveSupportSession:
        options.resolveSupportSession !== undefined
          ? options.resolveSupportSession
          : pool
            ? (tenantId: string, userId: string) =>
                activeSupportSession(pool, { tenantId, adminUser: userId })
            : null,
      // El plan del tenant decide el acceso al módulo (issue 209). Con caché
      // de 5 min: los planes cambian poco y esto corre en cada request.
      resolveAccesoModulo:
        options.resolveAccesoModulo !== undefined
          ? options.resolveAccesoModulo
          : pool
            ? async (tenantId: string, moduleId: string) => {
                const [vendibles, delPlan] = await Promise.all([
                  modulosVendibles(pool),
                  modulosDelPlan(pool, tenantId),
                ]);
                return accesoAlModulo({ moduleId, vendibles, delPlan: delPlan.modulos });
              }
            : null,
      onDenied: registrarRechazo(pool),
      onSupportAccess: registrarSoporte(pool),
    }),
    // La cuota mensual (#25) corre DESPUÉS del guard: solo API keys.
    new ApiQuotaGuard(redisConnection(), pool),
  );
  // Idempotency-Key (SPEC §28): DESPUÉS del guard, que es quien resuelve el
  // tenant — la llave es por tenant, como todo acá.
  if (pool) app.useGlobalInterceptors(new IdempotenciaInterceptor(pool));

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
