import type { Consumer } from '@iaxti/core';
import { bloquearGrantGoogle } from '@iaxti/module-identity';
import { writeAudit } from '@iaxti/module-audit';

/** Revocar desde Drive también retira leases/cache propios de Calendar.
 * Un evento antiguo no borra una conexión posterior: el grant vigente manda. */
export function googleCalendarConsumers(): Consumer[] {
  return [{name:'calendar.google_revoked',moduleId:'calendar',event:'integration.revoked',
    handler:async(event,c)=>{
      const {provider,userId,grantId}=event.payload;
      if(provider!=='google'||typeof userId!=='string'||typeof grantId!=='string')return;
      const grant=await bloquearGrantGoogle(c,{tenantId:event.tenantId,userId,noEsperar:true});
      if(!grant||grant.id!==grantId||grant.status!=='revoked')return;
      const removed=await c.query('DELETE FROM calendar_connections WHERE tenant_id=$1 AND user_id=$2 RETURNING id',[event.tenantId,userId]);
      if(removed.rowCount)await writeAudit(c,{tenantId:event.tenantId,actor:'system',actorKind:'system',action:'google.calendar.revoked',resource:'google_integration',resourceId:grantId,result:'ok'});
    }}];
}
