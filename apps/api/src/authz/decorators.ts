import { SetMetadata } from '@nestjs/common';

export const MODULE_KEY = 'iaxti:module';
export const PERMISSION_KEY = 'iaxti:permission';
export const AUTH_KEY = 'iaxti:auth';

/** El endpoint pertenece a un módulo: apagado ⇒ MODULE_DISABLED (SPEC §26). */
export const RequireModule = (moduleId: string) => SetMetadata(MODULE_KEY, moduleId);

/** El endpoint exige un permiso del catálogo (ADR-0008). */
export const RequirePermission = (permission: string) => SetMetadata(PERMISSION_KEY, permission);

/**
 * Solo exige sesión (JWT válido), SIN tenant ni permiso: para endpoints
 * previos a elegir negocio, como GET /me. El guard deja al usuario en
 * request.user.
 */
export const RequireAuth = () => SetMetadata(AUTH_KEY, true);
