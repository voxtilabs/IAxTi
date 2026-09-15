import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ModuleRegistry } from '@iaxti/core';
import { baseRoleHasPermission, isBaseRole } from '@iaxti/module-authorization';
import type { JwtVerifier } from '../auth/jwt';
import type { RoleResolver } from '../auth/role-resolver';
import type { WithRequestId } from '../request-id';
import { AUTH_KEY, MODULE_KEY, PERMISSION_KEY } from './decorators';

/** Lo que solo lee: pasa aunque el módulo esté fuera del plan (SPEC §6). */
const SOLO_LEE = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface Actor {
  userId: string;
  tenantId: string;
  role: string;
  /** 'apikey' cuando la request llegó con X-Api-Key (#24). */
  kind?: 'user' | 'apikey';
  /** Los scopes de la key: el techo de lo que puede hacer. */
  scopes?: string[];
}

export interface AuthenticatedUser {
  userId: string;
  email?: string;
}

export interface WithUser extends WithRequestId {
  user?: AuthenticatedUser;
  /** Presente tras pasar un @RequirePermission: usuario + tenant + rol. */
  actor?: Actor;
}

export interface AuthzOptions {
  /** Verificación del Bearer de Supabase; null desactiva ese camino. */
  jwtVerify?: JwtVerifier | null;
  /** Resuelve X-Api-Key (#24): hash → tenant + scopes; null lo apaga. */
  resolveApiKey?: ((token: string) => Promise<{ id: string; tenantId: string; scopes: string[] } | null>) | null;
  /** Permisos de un rol CUSTOM (#73): null = sin roles custom. */
  resolveCustomPermissions?: ((tenantId: string, roleName: string) => Promise<string[] | null>) | null;
  /** Rol desde user_roles; null obliga al stub de headers. */
  resolveRole?: RoleResolver | null;
  /** ¿SUPERADMIN de plataforma? (tabla platform_admins, cross-tenant). */
  resolvePlatformAdmin?: ((userId: string) => Promise<boolean>) | null;
  /**
   * El acceso del TENANT a un módulo según su plan (issue 209): 'completo'
   * o 'solo_lectura'. null lo apaga (tests y desarrollo sin base).
   */
  resolveAccesoModulo?:
    | ((tenantId: string, moduleId: string) => Promise<'completo' | 'solo_lectura'>)
    | null;
  /**
   * Aviso de rechazo (#71): lo escucha quien quiera dejarlo registrado. Es
   * BEST-EFFORT — el 403 sale igual aunque el registro falle, porque negar
   * el acceso importa más que contarlo.
   */
  onDenied?: ((info: {
    kind: 'permiso' | 'autenticacion';
    tenantId?: string;
    userId?: string;
    permission?: string;
    ip?: string;
    requestId?: string;
  }) => void) | null;
}

/** La IP del cliente detrás de Cloudflare; sin cabecera, la del socket. */
function ipDe(request: WithRequestId): string | undefined {
  const cf = request.headers['cf-connecting-ip'] ?? request.headers['x-forwarded-for'];
  const cruda = Array.isArray(cf) ? cf[0] : cf;
  const primera = cruda?.split(',')[0]?.trim();
  return primera || (request as { ip?: string }).ip || undefined;
}

/**
 * Guard único de autorización (ADR-0008): módulo activo + permiso del rol.
 * La verificación de dueño/equipo del objeto la agrega cada caso de uso.
 *
 * Identidad, en orden: (1) Authorization: Bearer <jwt de Supabase> +
 * X-Tenant-Id, con el rol resuelto desde user_roles; (2) fallback de
 * desarrollo por headers X-User-Id/X-Tenant-Id/X-Role — se retira en
 * hardening (#79-#84). El evento permission.denied al outbox llega cuando la
 * API tenga pool cableado en todos los ambientes.
 */
@Injectable()
export class AuthzGuard implements CanActivate {
  private readonly catalog: ReadonlySet<string>;

  constructor(
    private readonly reflector: Reflector,
    private readonly registry: ModuleRegistry,
    private readonly options: AuthzOptions = {},
  ) {
    this.catalog = new Set(registry.permissionsCatalog().keys());
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const moduleId = this.reflector.getAllAndOverride<string | undefined>(MODULE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const permission = this.reflector.getAllAndOverride<string | undefined>(PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const requireAuth = this.reflector.getAllAndOverride<boolean | undefined>(AUTH_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!moduleId && !permission && !requireAuth) return true; // público (salud, docs)

    // Solo sesión, sin tenant (GET /me): verifica el JWT y adjunta el usuario.
    if (requireAuth && !permission) {
      const request = context.switchToHttp().getRequest<WithUser>();
      request.user = await this.userFrom(context);
      return true;
    }

    if (moduleId && !this.registry.isActive(moduleId)) {
      throw new ForbiddenException({
        code: 'MODULE_DISABLED',
        message: 'Este módulo no está activo para tu cuenta. Revisa tu plan o pide activarlo.',
      });
    }

    // platform.*: SUPERADMIN cross-tenant (SPEC §22) — sin X-Tenant-Id;
    // la pertenencia viene de platform_admins, no de user_roles.
    if (permission?.startsWith('platform.')) {
      const request = context.switchToHttp().getRequest<WithUser>();
      const user = await this.userFrom(context);
      const isDevSuperadmin =
        !this.options.resolvePlatformAdmin && request.headers['x-role'] === 'SUPERADMIN';
      const isAdmin = this.options.resolvePlatformAdmin
        ? await this.options.resolvePlatformAdmin(user.userId)
        : isDevSuperadmin;
      if (!isAdmin || !baseRoleHasPermission('SUPERADMIN', permission, this.catalog)) {
        throw new ForbiddenException({
          code: 'PERMISSION_DENIED',
          message: 'Esta sección es solo para la operación de la plataforma.',
        });
      }
      request.user = user;
      return true;
    }

    if (permission) {
      const actor = await this.actorFrom(context);
      // API key (#24): el techo son SUS scopes — que ya nacieron como
      // subconjunto del catálogo del tenant; jamás cross-tenant (el
      // tenant viene DE la key, no de un header).
      const allowed =
        actor.kind === 'apikey'
          ? (actor.scopes ?? []).includes(permission)
          : isBaseRole(actor.role)
            ? baseRoleHasPermission(actor.role, permission, this.catalog)
            : this.options.resolveCustomPermissions
              ? ((await this.options.resolveCustomPermissions(actor.tenantId, actor.role)) ?? []).includes(permission)
              : false; // sin resolver de custom: rol desconocido = nada

      const request = context.switchToHttp().getRequest<WithUser>();
      request.actor = actor;
      request.user = { userId: actor.userId };

      // El PLAN del tenant (SPEC §6, issue 209): el portón de arriba mira un
      // flag global del despliegue; este mira lo que este tenant paga. Un
      // módulo fuera de su plan queda en SOLO LECTURA —bajar de plan nunca
      // borra ni esconde—, así que las lecturas pasan y las escrituras no.
      if (moduleId && this.options.resolveAccesoModulo) {
        const acceso = await this.options.resolveAccesoModulo(actor.tenantId, moduleId);
        if (acceso === 'solo_lectura' && !SOLO_LEE.has(request.method)) {
          throw new ForbiddenException({
            code: 'MODULE_NOT_IN_PLAN',
            message: 'Tu plan no incluye esta función. Puedes ver lo que ya tienes, pero no crear ni cambiar.',
          });
        }
      }

      if (!allowed) {
        console.warn(
          `[${request.requestId}] permission.denied tenant=${actor.tenantId} user=${actor.userId} permiso=${permission}`,
        );
        this.options.onDenied?.({
          kind: 'permiso',
          tenantId: actor.tenantId,
          userId: actor.userId,
          permission,
          ip: ipDe(request),
          requestId: request.requestId,
        });
        throw new ForbiddenException({
          code: 'PERMISSION_DENIED',
          message: 'Tu rol no permite esta acción. Pídele acceso a quien administra el equipo.',
        });
      }
    }
    return true;
  }

  /** JWT de Supabase o, en desarrollo, el header X-User-Id. */
  private async userFrom(context: ExecutionContext): Promise<AuthenticatedUser> {
    const request = context.switchToHttp().getRequest<WithRequestId>();
    const authorization = request.headers.authorization;

    if (typeof authorization === 'string' && authorization.startsWith('Bearer ') && this.options.jwtVerify) {
      try {
        return await this.options.jwtVerify(authorization.slice(7));
      } catch {
        // Un token que no verifica es el intento de autenticación fallido que
        // sí podemos ver: el login vive en Supabase, esta puerta es nuestra.
        this.options.onDenied?.({
          kind: 'autenticacion',
          ip: ipDe(request),
          requestId: request.requestId,
        });
        throw new UnauthorizedException({
          code: 'TOKEN_INVALID',
          message: 'Tu sesión no es válida o venció. Inicia sesión de nuevo.',
        });
      }
    }
    const userId = request.headers['x-user-id'];
    if (typeof userId !== 'string') {
      throw new UnauthorizedException({
        code: 'UNAUTHORIZED',
        message: 'Necesitas iniciar sesión para hacer esto.',
      });
    }
    return { userId };
  }

  private async actorFrom(context: ExecutionContext): Promise<Actor> {
    const request = context.switchToHttp().getRequest<WithRequestId>();
    const authorization = request.headers.authorization;

    // X-Api-Key (#24): mismo guard, mismos códigos de error.
    const apiKeyHeader = request.headers['x-api-key'];
    if (typeof apiKeyHeader === 'string' && apiKeyHeader && this.options.resolveApiKey) {
      const resolved = await this.options.resolveApiKey(apiKeyHeader);
      if (!resolved) {
        throw new UnauthorizedException({
          code: 'API_KEY_INVALID',
          message: 'Esa API key no es válida, venció o fue revocada.',
        });
      }
      return {
        userId: `apikey:${resolved.id}`,
        tenantId: resolved.tenantId,
        role: 'APIKEY',
        kind: 'apikey',
        scopes: resolved.scopes,
      };
    }

    if (typeof authorization === 'string' && authorization.startsWith('Bearer ') && this.options.jwtVerify) {
      let userId: string;
      try {
        ({ userId } = await this.options.jwtVerify(authorization.slice(7)));
      } catch {
        throw new UnauthorizedException({
          code: 'TOKEN_INVALID',
          message: 'Tu sesión no es válida o venció. Inicia sesión de nuevo.',
        });
      }
      const tenantId = request.headers['x-tenant-id'];
      if (typeof tenantId !== 'string') {
        throw new UnauthorizedException({
          code: 'TENANT_REQUIRED',
          message: 'Indica el negocio (X-Tenant-Id) para continuar.',
        });
      }
      const role = this.options.resolveRole
        ? await this.options.resolveRole(tenantId, userId)
        : null;
      if (!role) {
        throw new ForbiddenException({
          code: 'NOT_A_MEMBER',
          message: 'No perteneces a este negocio. Pide una invitación a quien lo administra.',
        });
      }
      return { userId, tenantId, role };
    }

    // Fallback de desarrollo (se retira en hardening).
    const userId = request.headers['x-user-id'];
    const tenantId = request.headers['x-tenant-id'];
    const role = request.headers['x-role'];
    if (typeof userId !== 'string' || typeof tenantId !== 'string' || typeof role !== 'string') {
      throw new UnauthorizedException({
        code: 'UNAUTHORIZED',
        message: 'Necesitas iniciar sesión para hacer esto.',
      });
    }
    return { userId, tenantId, role };
  }
}
