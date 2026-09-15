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
