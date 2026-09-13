// Única puerta pública del módulo audit (SPEC §26). Los demás módulos
// escriben su auditoría con writeAudit DENTRO de su misma transacción.
export const MODULE_ID = 'audit' as const;
export { writeAudit, verifyChain } from './src/write';
export type { AuditEntry, ActorKind, ChainCheck } from './src/write';
export { searchAudit } from './src/search';
export type { AuditFilter } from './src/search';
