import type { PoolClient } from 'pg';
/** Puerto para integraciones opcionales. SHARE coordina una lectura/copia con
 * la supresión (FOR UPDATE), sin depender de nombres o teléfonos vacíos. */
export async function contactoAnonimizado(client:PoolClient,tenantId:string,contactId:string,options:{bloquear?:boolean}={}):Promise<boolean>{
  const result=await client.query(`SELECT anonymized_at FROM contacts WHERE tenant_id=$1 AND id=$2${options.bloquear?' FOR SHARE':''}`,[tenantId,contactId]);
  if(!result.rowCount)throw new Error('No encontramos ese contacto en este negocio.');
  return result.rows[0].anonymized_at!==null;
}
