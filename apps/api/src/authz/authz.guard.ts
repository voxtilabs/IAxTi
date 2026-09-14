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

export interface Actor {
  userId: string;
  tenantId: string;
  role: string;
}

export interface AuthenticatedUser {
  userId: string;
  email?: string;
}

export interface WithUser extends WithRequestId {
  user?: AuthenticatedUser;
}

export interface AuthzOptions {
  /** Verificación del Bearer de Supabase; null desactiva ese camino. */
  jwtVerify?: JwtVerifier | null;
  /** Rol desde user_roles; null obliga al stub de headers. */
  resolveRole?: RoleResolver | null;
  /** ¿SUPERADMIN de plataforma? (tabla platform_admins, cross-tenant). */
  resolvePlatformAdmin?: ((userId: string) => Promise<boolean>) | null;
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
      const allowed = isBaseRole(actor.role)
        ? baseRoleHasPermission(actor.role, permission, this.catalog)
        : false; // roles custom llegan con #73, vía base de datos

      if (!allowed) {
        const request = context.switchToHttp().getRequest<WithRequestId>();
        console.warn(
          `[${request.requestId}] permission.denied tenant=${actor.tenantId} user=${actor.userId} permiso=${permission}`,
        );
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
