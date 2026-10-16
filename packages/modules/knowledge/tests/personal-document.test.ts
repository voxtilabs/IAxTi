import {expect,it,vi} from 'vitest';
import {buscarDocumentoPersonal} from '../application/personal-document';
it('texto autorizado en memoria devuelve dos pasajes acotados sin red',async()=>{
  const send=vi.fn();vi.stubGlobal('fetch',send);
  try{const result=await buscarDocumentoPersonal({bytes:new TextEncoder().encode('Servicio '.repeat(3000)),mimeType:'text/plain',query:'servicio'});expect(result).toHaveLength(2);expect(result.every(part=>part.text.length<=1200)).toBe(true);expect(send).not.toHaveBeenCalled();}finally{vi.unstubAllGlobals();}
});
it('PDF, UTF8 inválido y bytes fuera de límite fallan explícitamente sin proveedor IA',async()=>{
  const send=vi.fn();vi.stubGlobal('fetch',send);
  try{for(const input of [{bytes:new Uint8Array([1]),mimeType:'application/pdf'},{bytes:new Uint8Array([255]),mimeType:'text/plain'},{bytes:new Uint8Array(2*1024*1024+1),mimeType:'text/plain'}])await expect(buscarDocumentoPersonal({...input,query:'x'})).rejects.toThrow();expect(send).not.toHaveBeenCalled();}finally{vi.unstubAllGlobals();}
});
