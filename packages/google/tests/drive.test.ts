import {describe,expect,it,vi} from 'vitest';
import {createGoogleDriveClient} from '../src/drive';
const file={id:'file_one',name:'Documento',mimeType:'text/plain',webViewLink:'https://drive.google.com/file/d/file_one/view',size:'3',md5Checksum:'5289df737df57326fcdd22597afb1fac',capabilities:{canDownload:true}};
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});
describe('Drive REST oficial, transporte HTTP sustituido',()=>{
  it('metadata usa drive v3, campos mínimos y Bearer sin URLs de caller',async()=>{
    const send=vi.fn<typeof fetch>().mockResolvedValue(json(file));const client=createGoogleDriveClient({fetch:send});
    expect((await client.get({accessToken:'secret-test',fileId:'file_one'})).id).toBe('file_one');
    expect(String(send.mock.calls[0][0])).toMatch(/^https:\/\/www.googleapis.com\/drive\/v3\/files\/file_one\?/);
    expect(send.mock.calls[0][1]).toMatchObject({redirect:'error',headers:{Authorization:'Bearer secret-test'}});
    expect(()=>client.get({accessToken:'secret',fileId:'../other'})).toThrow('GOOGLE_INPUT_INVALID');
  });
  it('rechaza metadata de otro ID, enlaces externos y tamaños no finitos',async()=>{
    for(const change of [{id:'other'},{webViewLink:'https://evil.test/x'},{size:'Infinity'}]){
      const client=createGoogleDriveClient({fetch:vi.fn().mockResolvedValue(json({...file,...change}))});
      await expect(client.get({accessToken:'secret',fileId:'file_one'})).rejects.toThrow();
    }
  });
  it('exporta texto nativo, corta bytes y propaga abort al proveedor',async()=>{
    const send=vi.fn<typeof fetch>().mockResolvedValue(new Response('hola'));const client=createGoogleDriveClient({fetch:send});
    expect(await client.read({accessToken:'secret',fileId:'file_one',mimeType:'application/vnd.google-apps.document'})).toMatchObject({mimeType:'text/plain'});
    expect(String(send.mock.calls[0][0])).toContain('/export?mimeType=text%2Fplain');
    send.mockResolvedValue(new Response('demasiado'));await expect(client.read({accessToken:'secret',fileId:'file_one',mimeType:'text/plain',maxBytes:3})).rejects.toThrow('GOOGLE_RESPONSE_INVALID');
    const abort=new AbortController();abort.abort();await expect(client.get({accessToken:'secret',fileId:'file_one',signal:abort.signal})).rejects.toThrow('GOOGLE_REQUEST_ABORTED');
  });
  it('no filtra cuerpos del proveedor con 403/404/timeout',async()=>{
    for(const status of [403,404]){
      const client=createGoogleDriveClient({fetch:vi.fn().mockResolvedValue(json({error:'PRIVATE-RESPONSE'},status))});
      try{await client.get({accessToken:'secret',fileId:'file_one'});throw new Error('Expected rejection');}catch(error){expect(String(error)).not.toContain('PRIVATE');expect(error).toMatchObject({status});}
    }
  });
  it('crea carpeta con ID preasignado y conflicto valida marca antes de reutilizar',async()=>{
    const send=vi.fn<typeof fetch>().mockResolvedValueOnce(json({},409)).mockResolvedValueOnce(json({...file,mimeType:'application/vnd.google-apps.folder',appProperties:{iaxti:'intent'}}));
    const client=createGoogleDriveClient({fetch:send});expect((await client.createFolder({accessToken:'secret',fileId:'file_one',name:'Ana',marker:'intent'})).id).toBe('file_one');
    expect(JSON.parse(String(send.mock.calls[0][1]?.body))).toMatchObject({id:'file_one',appProperties:{iaxti:'intent'}});
    send.mockResolvedValueOnce(json({},409)).mockResolvedValueOnce(json({...file,mimeType:'application/vnd.google-apps.folder',appProperties:{iaxti:'foreign'}}));
    await expect(client.createFolder({accessToken:'secret',fileId:'file_one',name:'Ana',marker:'intent'})).rejects.toThrow('GOOGLE_RESPONSE_INVALID');
  });
  it('sube binario por sesión resumible, nunca devuelve ni persiste Location',async()=>{
    const location='https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=PRIVATE-SESSION';
    const send=vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null,{headers:{location}})).mockResolvedValueOnce(json(file));
    const result=await createGoogleDriveClient({fetch:send}).upload({accessToken:'secret',fileId:'file_one',folderId:'folder',name:'a.txt',mimeType:'text/plain',bytes:new Uint8Array([1,2,3]),marker:'intent'});
    expect(send.mock.calls[1][1]).toMatchObject({method:'PUT',body:new Uint8Array([1,2,3])});expect(JSON.stringify(result)).not.toContain('PRIVATE-SESSION');
  });
  it('Location ajena no recibe los bytes ni credenciales',async()=>{
    const send=vi.fn<typeof fetch>().mockResolvedValue(new Response(null,{headers:{location:'https://evil.test/upload'}}));
    await expect(createGoogleDriveClient({fetch:send}).upload({accessToken:'secret',fileId:'file_one',folderId:'folder',name:'a.txt',mimeType:'text/plain',bytes:new Uint8Array([1,2,3]),marker:'intent'})).rejects.toThrow('GOOGLE_RESPONSE_INVALID');expect(send).toHaveBeenCalledTimes(1);
  });
  it('reintentar tras commit remoto incierto reutiliza ID solo con marca, carpeta y tamaño exactos',async()=>{
    for(const valid of [true,false]){
      const send=vi.fn<typeof fetch>().mockResolvedValueOnce(json({},409)).mockResolvedValueOnce(json({...file,appProperties:{iaxti:valid?'intent':'other'},parents:['folder']}));
      const operation=createGoogleDriveClient({fetch:send}).upload({accessToken:'secret',fileId:'file_one',folderId:'folder',name:'a.txt',mimeType:'text/plain',bytes:new Uint8Array([1,2,3]),marker:'intent'});
      if(valid)expect((await operation).id).toBe('file_one');else await expect(operation).rejects.toThrow('GOOGLE_RESPONSE_INVALID');
      expect(send).toHaveBeenCalledTimes(2);
    }
  });
});
