import { SetMetadata } from '@nestjs/common';

export const MODULE_KEY = 'iaxti:module';
export const PERMISSION_KEY = 'iaxti:permission';

/** El endpoint pertenece a un módulo: apagado ⇒ MODULE_DISABLED (SPEC §26). */
export const RequireModule = (moduleId: string) => SetMetadata(MODULE_KEY, moduleId);

/** El endpoint exige un permiso del catálogo (ADR-0008). */
export const RequirePermission = (permission: string) => SetMetadata(PERMISSION_KEY, permission);
