import { storageFromEnv,presignUrl } from '@iaxti/core';
import type { DriveAttachmentStorage } from '@iaxti/module-integrations';
export const driveAttachmentStorage:DriveAttachmentStorage={async read(tenantId,key,maxBytes){
  if(!key.startsWith(`${tenantId}/`))throw new Error('El adjunto no pertenece al negocio.');
  const storage=storageFromEnv();if(!storage)throw new Error('Almacenamiento no configurado.');
  const response=await fetch(presignUrl(storage,'GET',key),{redirect:'error',signal:AbortSignal.timeout(30_000)});
  if(!response.ok||!response.body)throw new Error('No pudimos leer el adjunto.');
  const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes)throw new Error('El adjunto supera el límite admitido.');chunks.push(value);}}
  catch(error){await reader.cancel();throw error;}
  return new Uint8Array(Buffer.concat(chunks));
}};
