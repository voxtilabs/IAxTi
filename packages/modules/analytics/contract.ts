// Única puerta pública del módulo analytics (SPEC §26).
export const MODULE_ID = 'analytics' as const;
export { analyticsConsumers, sweepResponseSamples, bump } from './application/aggregate';
export { getDashboard } from './application/dashboard';
// Los números de a uno y con su definición, para el asistente del dueño (#410).
export { metricaEnRango, catalogoDeMetricas, esMetrica } from './application/para-el-asistente';
export type { MetricaParaElAsistente } from './application/para-el-asistente';
export type { DashboardInput, DashboardResult } from './application/dashboard';
export { METRICS, DEFINICIONES, TOTAL_OWNER } from './domain/metrics';
export type { Metric } from './domain/metrics';
// La definición vive en core: un solo "hoy" para todo el sistema.
export { diaEn, mesEn, ultimosDias, esDia, TZ_POR_DEFECTO } from '@iaxti/core';
