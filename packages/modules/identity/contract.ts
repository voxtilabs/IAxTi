// Única puerta pública del módulo identity (SPEC §26).
export const MODULE_ID = 'identity' as const;
export {
  createInvitation,
  acceptInvitation,
  roleOf,
  tenantsOf,
  upsertProfile,
  listarEquipo,
  listarInvitaciones,
  cancelarInvitacion,
  quitarDelEquipo,
} from './application/invitations';
export type {
  Invitation,
  Membership,
  MiembroEquipo,
  InvitacionPendiente,
} from './application/invitations';
// Quién hizo esto (#697): nueve columnas guardaban el autor y ninguna pantalla
// lo mostraba. El nombre vive en user_profiles y la pertenencia en user_roles,
// las dos de identity, así que el resto pregunta por acá.
// `quienEs` queda interno: todo lo de afuera resuelve varios ids de una vez con
// `quienesSon` + `quienFue`, y publicar lo que nadie abre convierte el contrato
// en un trámite (#664).
export { quienesSon, quienesSonEnLaPlataforma, quienFue } from './application/quien';
export type { Quien } from './application/quien';
