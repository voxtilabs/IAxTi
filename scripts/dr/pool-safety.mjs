// pg emite errores de clientes ociosos fuera del catch de query. Jamás reenviar
// el objeto (incluye client/connectionParameters), ni anunciar éxito después.
export function watchPool(pool,onFailure){
 let failed=false;
 pool.on('error',()=>{if(!failed){failed=true;onFailure('DR_CONNECTION_INTERRUPTED');}});
 return ()=>{if(failed)throw new Error('DR_CONNECTION_INTERRUPTED');};
}
