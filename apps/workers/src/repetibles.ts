import type { Repetible } from '@iaxti/core';

/**
 * Las tareas que se repiten, declaradas (§39, zona America/Santiago).
 *
 * En una lista y no desparramadas en diecisiete llamadas seguidas porque hay
 * tres cosas que preguntarle a este conjunto y antes ninguna se podía:
 * cuántas son, si quedaron programadas, y si el runbook las nombra todas. La
 * tabla del §4 de ANTES-DE-PRODUCCION.md listaba cinco de diecisiete (#807).
 *
 * `add` repetido con la misma pauta es idempotente entre reinicios.
 */
export const REPETIBLES: Repetible[] = [
  { nombre: 'conversations.checks', moduleId: 'conversations', repeat: { every: 60_000 } },
  { nombre: 'crm.activities_due', moduleId: 'crm', repeat: { every: 60_000 } },
  { nombre: 'webhooks.deliver', moduleId: 'integrations', repeat: { every: 60_000 } },
  // Cada cinco minutos (#502). Va seguido porque mientras haya fuentes sin
  // indexar el negocio tiene la IA sin conocimiento; y no más seguido porque
  // el barrido pasa por todos los negocios y cada fuente reindexada le paga
  // al proveedor.
  { nombre: 'knowledge.reindex', moduleId: 'knowledge', repeat: { every: 300_000 } },
  { nombre: 'automations.sweep', moduleId: 'automations', repeat: { every: 300_000 } },
  { nombre: 'api_usage.flush', moduleId: 'organizations', repeat: { every: 300_000 } },
  // Limpieza del lifecycle sigue activa aunque Calendar se apague.
  { nombre: 'identity.google.cleanup', moduleId: 'identity', repeat: { every: 900_000 } },
  // Renovación de leases push; no consulta eventos.
  { nombre: 'integrations.gmail.maintain', moduleId: 'integrations', repeat: { every: 900_000 } },
  { nombre: 'calendar.google.maintain', moduleId: 'calendar', repeat: { every: 900_000 } },
  { nombre: 'calendar.reminders', moduleId: 'calendar', repeat: { every: 900_000 } },
  // Meta tarda de minutos a 24 h en revisar una plantilla. Cada 30 min
  // alcanza de sobra y no castiga al proveedor con preguntas cada minuto.
  { nombre: 'whatsapp.templates.sync', moduleId: 'whatsapp', repeat: { every: 1_800_000 } },
  {
    nombre: 'conversations.auto_resolve',
    moduleId: 'conversations',
    repeat: { pattern: '0 * * * *', tz: 'America/Santiago' },
  },
  {
    nombre: 'knowledge.expire',
    moduleId: 'knowledge',
    repeat: { pattern: '30 * * * *', tz: 'America/Santiago' },
  },
  {
    nombre: 'analytics.response_samples',
    moduleId: 'analytics',
    repeat: { pattern: '15 * * * *', tz: 'America/Santiago' },
  },
  {
    nombre: 'payments.expire',
    moduleId: 'payments',
    repeat: { pattern: '45 * * * *', tz: 'America/Santiago' },
  },
  {
    nombre: 'idempotency.sweep',
    // `organizations`, no 'core': el registro solo conoce módulos, y
    // `isActive('core')` es false — el barrido no habría corrido nunca.
    moduleId: 'organizations',
    repeat: { pattern: '20 * * * *', tz: 'America/Santiago' },
  },
  {
    nombre: 'crm.stalled',
    moduleId: 'crm',
    repeat: { pattern: '0 7 * * *', tz: 'America/Santiago' },
  },
  {
    nombre: 'conversations.archive',
    moduleId: 'conversations',
    repeat: { pattern: '0 3 * * *', tz: 'America/Santiago' },
  },
  {
    nombre: 'conversations.retention',
    moduleId: 'conversations',
    repeat: { pattern: '0 4 * * *', tz: 'America/Santiago' },
  },
  {
    nombre: 'billing.sweep',
    moduleId: 'billing',
    repeat: { pattern: '0 4 * * *', tz: 'America/Santiago' },
  },
];
