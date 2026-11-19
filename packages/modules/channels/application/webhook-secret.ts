/**
 * Solo referencias generadas por el servidor para ESTA cuenta, nunca URLs del cliente.
 *
 * El nombre dice «zavu» y es HISTÓRICO: es la forma que ya tienen las
 * referencias custodiadas en las bases (las dejó el flujo de invitación que
 * #1339 retiró), y esta función es hoy quien VALIDA que una referencia `sm:`
 * pertenezca a esta cuenta. Renombrarlo invalidaría en un golpe todas las
 * referencias vivas —una migración de dos pasos que nadie necesita—; si algún
 * día vuelven a GENERARSE referencias `sm:`, que se decida ahí con su ventana
 * de compatibilidad.
 */
export function webhookSecretResourcePrefix(tenantId: string, accountId: string): string {
  return `iaxti-zavu-${tenantId.replaceAll('-', '')}-${accountId.replaceAll('-', '')}-`;
}
export function isChannelSecretRef(ref: string, tenantId: string, accountId: string): boolean {
  const match = /^sm:(projects\/(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]{1,20})\/secrets\/([A-Za-z0-9_-]+)\/versions\/[1-9][0-9]{0,19})$/.exec(ref);
  return !!match && match[2]!.startsWith(webhookSecretResourcePrefix(tenantId, accountId))
    && /^[a-f0-9]{32}$/.test(match[2]!.slice(webhookSecretResourcePrefix(tenantId, accountId).length));
}
// La mitad que ESCRIBÍA referencias (`setChannelWebhookSecret` y la herencia
// de custodia #74) se fue con el flujo de invitación que las llamaba (#1339).
// Quedan solo las funciones que VALIDAN y resuelven, que es todo lo que el
// webhook usa en cada entrega.
