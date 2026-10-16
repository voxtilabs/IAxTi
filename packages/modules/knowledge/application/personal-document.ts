import { normalizeQuery, splitIntoChunks } from '../domain/chunking';

export interface PersonalDocumentHit {text:string;part:number}
/** Capacidad sin persistencia ni caché de tenant. El consumidor acredita el
 * permiso personal ANTES de entregar bytes y no comparte el resultado. */
export async function buscarDocumentoPersonal(input:{bytes:Uint8Array;mimeType:string;query:string}):Promise<PersonalDocumentHit[]> {
  if(input.bytes.byteLength>2*1024*1024)throw new Error('Ese documento es demasiado grande para consultarlo.');
  let content:string;
  if(['text/plain','text/markdown','text/csv'].includes(input.mimeType))content=new TextDecoder('utf-8',{fatal:true}).decode(input.bytes);
  else throw new Error('Este tipo de documento todavía no se puede leer como conocimiento.');
  const words=normalizeQuery(input.query).split(' ').filter(word=>word.length>2);
  const chunks=splitIntoChunks(content).flatMap((text,index)=>{
    // Un párrafo sin puntuación puede superar el tamaño del troceador general.
    const parts:PersonalDocumentHit[]=[];for(let i=0;i<text.length;i+=1200)parts.push({text:text.slice(i,i+1200),part:index+1});return parts;
  });
  return chunks.map(hit=>({...hit,score:words.filter(word=>normalizeQuery(hit.text).includes(word)).length}))
    .filter(hit=>!words.length||hit.score>0).sort((a,b)=>b.score-a.score||a.part-b.part).slice(0,2).map(({text,part})=>({text,part}));
}
