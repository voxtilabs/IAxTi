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
import type { WithRequestId } from '../request-id';
import { MODULE_KEY, PERMISSION_KEY } from './decorators';

export interface Actor {
  userId: string;
  tenantId: string;
  role: string;
}

/**
 * Guard único de autorización (ADR-0008): módulo activo + permiso del rol.
 * La verificación de dueño/equipo del objeto la agrega cada caso de uso.
 *
 * IDENTIDAD (stub hasta #7): X-User-Id, X-Tenant-Id y X-Role. Cuando llegue
 * Supabase Auth, el JWT reemplaza los headers y este guard no cambia.
 * El evento permission.denied se conecta al outbox junto con #7.
 */
@Injectable()
export class AuthzGuard implements CanActivate {
  private readonly catalog: ReadonlySet<string>;

  constructor(
    private readonly reflector: Reflector,
    private readonly registry: ModuleRegistry,
  ) {
    this.catalog = new Set(registry.permissionsCatalog().keys());
  }

  canActivate(context: ExecutionContext): boolean {
    const moduleId = this.reflector.getAllAndOverride<string | undefined>(MODULE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const permission = this.reflector.getAllAndOverride<string | undefined>(PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!moduleId && !permission) return true; // endpoint público (salud, docs)

    if (moduleId && !this.registry.isActive(moduleId)) {
      throw new ForbiddenException({
        code: 'MODULE_DISABLED',
        message: 'Este módulo no está activo para tu cuenta. Revisa tu plan o pide activarlo.',
      });
    }

    if (permission) {
      const actor = this.actorFrom(context);
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

  private actorFrom(context: ExecutionContext): Actor {
    const request = context.switchToHttp().getRequest<WithRequestId>();
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
