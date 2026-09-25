import { SetMetadata, applyDecorators } from '@nestjs/common';
import { ApiExtension } from '@nestjs/swagger';

export const MODULE_KEY = 'iaxti:module';
export const PERMISSION_KEY = 'iaxti:permission';
export const AUTH_KEY = 'iaxti:auth';

/**
 * Los decoradores hacen DOS cosas, y la segunda es nueva (#492).
 *
 * Además de dejar la metadata que lee el guard, la escriben en el documento
 * OpenAPI como extensión `x-iaxti-*`. Con eso el documento pasa a saber qué
 * permiso y qué módulo exige cada operación, y el catálogo de herramientas
 * del Agente General se GENERA de ahí en vez de adivinarlo leyendo el
 * código fuente.
 *
 * Que salga del mismo decorador no es comodidad: es la única forma de que
 * el documento no se desincronice. Un endpoint nuevo trae su permiso al
 * documento el día que se escribe, sin que nadie se acuerde de anotarlo en
 * otra parte.
 */

/** El endpoint pertenece a un módulo: apagado ⇒ MODULE_DISABLED (SPEC §26). */
export const RequireModule = (moduleId: string) =>
  applyDecorators(SetMetadata(MODULE_KEY, moduleId), ApiExtension('x-iaxti-module', moduleId));

/** El endpoint exige un permiso del catálogo (ADR-0008). */
export const RequirePermission = (permission: string) =>
  applyDecorators(
    SetMetadata(PERMISSION_KEY, permission),
    ApiExtension('x-iaxti-permission', permission),
  );

/**
 * Solo exige sesión (JWT válido), SIN tenant ni permiso: para endpoints
 * previos a elegir negocio, como GET /me. El guard deja al usuario en
 * request.user.
 */
export const RequireAuth = () =>
  applyDecorators(SetMetadata(AUTH_KEY, true), ApiExtension('x-iaxti-auth', 'sesion'));
