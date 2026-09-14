// Única puerta pública del módulo identity (SPEC §26).
export const MODULE_ID = 'identity' as const;
export {
  createInvitation,
  acceptInvitation,
  roleOf,
  tenantsOf,
  upsertProfile,
} from './application/invitations';
export type { Invitation, Membership } from './application/invitations';
