// Única puerta pública del módulo analytics (SPEC §26).
export const MODULE_ID = 'analytics' as const;
export { analyticsConsumers, sweepResponseSamples, bump } from './application/aggregate';
export { getDashboard } from './application/dashboard';
export type { DashboardInput, DashboardResult } from './application/dashboard';
export { METRICS, DEFINICIONES, TOTAL_OWNER } from './domain/metrics';
export type { Metric } from './domain/metrics';
