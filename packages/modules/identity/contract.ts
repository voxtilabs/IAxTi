// Única puerta pública del módulo identity (SPEC §26).
export const MODULE_ID = 'identity' as const;
export {
  createInvitation,
  acceptInvitation,
  roleOf,
  upsertProfile,
} from './application/invitations';
export type { Invitation } from './application/invitations';
