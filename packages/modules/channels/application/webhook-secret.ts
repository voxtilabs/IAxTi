import type { PoolClient } from 'pg';
import { writeAudit } from '@iaxti/module-audit';
import { getChannelAccount } from './accounts';

/** Solo referencias generadas por el servidor para ESTA cuenta, nunca URLs del cliente. */
export function webhookSecretResourcePrefix(tenantId: string, accountId: string): string {
  return `iaxti-zavu-${tenantId.replaceAll('-', '')}-${accountId.replaceAll('-', '')}-`;
}
export function isChannelSecretRef(ref: string, tenantId: string, accountId: string): boolean {
  const match = /^sm:(projects\/(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]{1,20})\/secrets\/([A-Za-z0-9_-]+)\/versions\/[1-9][0-9]{0,19})$/.exec(ref);
  return !!match && match[2]!.startsWith(webhookSecretResourcePrefix(tenantId, accountId))
    && /^[a-f0-9]{32}$/.test(match[2]!.slice(webhookSecretResourcePrefix(tenantId, accountId).length));
}
export async function setChannelWebhookSecret(client: PoolClient, input: {tenantId: string; accountId: string; ref: string}) {
  const account = await getChannelAccount(client,input.tenantId,input.accountId);
  if (account.state !== 'connecting' || !isChannelSecretRef(input.ref,input.tenantId,input.accountId)) throw new Error('La referencia no corresponde a esta conexión pendiente.');
  await client.query('UPDATE channel_accounts SET webhook_secret_ref=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2',[input.tenantId,input.accountId,input.ref]);
  await writeAudit(client,{tenantId:input.tenantId,actor:'system',actorKind:'system',action:'channel.webhook.custodied',resource:'channel_account',resourceId:input.accountId,result:'ok'});
}

/** Hereda la custodia del único receptor de un sender multicanal (#74). */
export async function copyChannelWebhookSecret(client:PoolClient,input:{tenantId:string;sourceAccountId:string;accountId:string}) {
  const source=await getChannelAccount(client,input.tenantId,input.sourceAccountId);
  const target=await getChannelAccount(client,input.tenantId,input.accountId);
  if(source.config.senderId!==target.config.senderId || target.state!=='connecting' || !source.webhookSecretRef || !isChannelSecretRef(source.webhookSecretRef,input.tenantId,source.id))throw new Error('La custodia no corresponde a este emisor.');
  await client.query('UPDATE channel_accounts SET webhook_secret_ref=$3 WHERE tenant_id=$1 AND id=$2',[input.tenantId,input.accountId,source.webhookSecretRef]);
  await writeAudit(client,{tenantId:input.tenantId,actor:'system',actorKind:'system',action:'channel.webhook.inherited',resource:'channel_account',resourceId:input.accountId,result:'ok'});
}
