export { createPool } from './client';
export { withTenant, idsDeTenants, porCadaTenant } from './tenant';
export { runMigrations, topologicalOrder, findModulesDir } from './migrate';
export type { AppliedMigration } from './migrate';
export { estadoRls, exigeRolQueRespetaRls } from './rls';
export type { EstadoRls } from './rls';
export { permisosDelRol, comoSeLee } from './permisos-del-rol';
export type { DiagnosticoDelRol, FaltaDelRol } from './permisos-del-rol';
// Que la API de datos de Supabase no vea nada nuestro (#456).
export { blindarEsquema } from './blindaje';
export type { ResultadoBlindaje } from './blindaje';
