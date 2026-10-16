import { bearer, createTransport, inputText, invalidInput, invalidResponse, record, text, type GoogleRequestOptions, type GoogleTransportOptions } from './http';

export const GOOGLE_GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const ROOT = 'https://gmail.googleapis.com/gmail/v1/users/me';
export interface GmailThread { id: string; subject: string; snippet: string; lastMessageAt: string }
export interface GmailThreads { threads: GmailThread[]; truncated: boolean }
export interface GoogleGmailClient {
  profile(accessToken: string, options?: GoogleRequestOptions): Promise<{emailAddress: string; historyId: string}>;
  threads(input: {accessToken: string; email: string} & GoogleRequestOptions): Promise<GmailThreads>;
  watch(input: {accessToken: string; topicName: string} & GoogleRequestOptions): Promise<{historyId: string; expiration: number}>;
  stop(accessToken: string, options?: GoogleRequestOptions): Promise<void>;
}
/** El correo viene del CRM. Rechazar sintaxis que podría cambiar la consulta. */
export function gmailContactEmail(value: string): string {
  if (typeof value !== 'string' || value.length > 254 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(value)
    || value.includes('..') || value.startsWith('.') || value.includes('.@')) return invalidInput();
  return value.toLowerCase();
}
function decimal(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,39}$/.test(value)) return invalidResponse();
  return value;
}
function id(value: unknown): string { const s=text(value,128); if(!/^[A-Za-z0-9_-]+$/.test(s))return invalidResponse();return s; }
function display(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) return invalidResponse();
  return value.replace(/[\r\n]+/g,' ');
}
/** Direcciones estructuradas; el nombre visible nunca cuenta como participante.
 * Soporta nombres entre comillas, comentarios y grupos. Local-parts entre
 * comillas no forman parte del contrato del correo CRM y no se equiparan. */
function addresses(value: string): string[] {
  if(value.length>32000||/[\r\n\0]/.test(value))return invalidResponse();
  const parts:string[]=[];let part='';let quote=false;let escape=false;let comment=0;let angle=false;
  for(const char of value){
    if(escape){if(!comment)part+=char;escape=false;continue;}
    if(char==='\\'&&(quote||comment)){if(!comment)part+=char;escape=true;continue;}
    if(comment){if(char==='(')comment++;if(char===')')comment--;continue;}
    if(char==='"'){quote=!quote;part+=char;continue;}
    if(!quote&&char==='('){comment++;continue;}
    if(!quote&&char==='<')angle=true;
    if(!quote&&char==='>')angle=false;
    if(!quote&&!angle&&(char===','||char===';')){parts.push(part);part='';continue;}
    if(!quote&&!angle&&char===':'){part='';continue;}
    part+=char;
  }
  if(quote||angle||comment||escape)return invalidResponse();
  parts.push(part);
  return parts.flatMap(p=>{
    const s=p.trim();if(!s)return[];
    const match=/^[^<>]*<([^<>]+)>\s*$/.exec(s);
    const candidate=(match?match[1]:s).trim();
    try{return[gmailContactEmail(candidate)];}catch{return[];}
  });
}
function thread(value:unknown,email:string):GmailThread|null {
  const data=record(value);const threadId=id(data.id);
  if(!Array.isArray(data.messages)||data.messages.length===0||data.messages.length>10000)return invalidResponse();
  const matching=data.messages.flatMap(raw=>{
    const message=record(raw);const payload=record(message.payload);
    if(!Array.isArray(payload.headers))return invalidResponse();
    const headers=payload.headers.map(rawHeader=>{const h=record(rawHeader);return{name:text(h.name,200).toLowerCase(),value:display(h.value,32000)};});
    if(!headers.some(h=>['from','to','cc','bcc'].includes(h.name)&&addresses(h.value).includes(email)))return[];
    const stamp=Number(decimal(message.internalDate));
    if(!Number.isSafeInteger(stamp)||stamp<=0||stamp>8640000000000000)return invalidResponse();
    return[{id:threadId,subject:headers.find(h=>h.name==='subject')?.value??'',snippet:display(message.snippet,16000),lastMessageAt:new Date(stamp).toISOString()}];
  });
  return matching.sort((a,b)=>b.lastMessageAt.localeCompare(a.lastMessageAt))[0]??null;
}
export function createGoogleGmailClient(options:GoogleTransportOptions={}):GoogleGmailClient {
  const request=createTransport(options);
  return {
    async profile(accessToken,opt={}){
      const data=record(await request(`${ROOT}/profile?fields=emailAddress,historyId`,{method:'GET',headers:{Authorization:bearer(accessToken)}},opt));
      let emailAddress:string;try{emailAddress=gmailContactEmail(text(data.emailAddress,254));}catch{return invalidResponse();}
      return{emailAddress,historyId:decimal(data.historyId)};
    },
    async threads({accessToken,email,...opt}){
      email=gmailContactEmail(email);
      const headers={Authorization:bearer(accessToken)};
      const deadline=AbortSignal.timeout(20000);
      const signal=opt.signal?AbortSignal.any([deadline,opt.signal]):deadline;
      const ids=new Set<string>();let page:string|undefined;let truncated=false;
      // No se promete orden del proveedor: el recorte se indica explícitamente.
      for(let count=0;count<3;count++){
        const query=new URLSearchParams({q:`{from:"${email}" to:"${email}" cc:"${email}" bcc:"${email}"}`,maxResults:'50',fields:'threads(id),nextPageToken'});
        if(page)query.set('pageToken',page);
        const data=record(await request(`${ROOT}/threads?${query}`,{method:'GET',headers},{signal}));
        if(data.threads!==undefined&&!Array.isArray(data.threads))return invalidResponse();
        for(const raw of (data.threads??[]) as unknown[]){if(ids.size>=100){truncated=true;break;}ids.add(id(record(raw).id));}
        page=data.nextPageToken===undefined?undefined:text(data.nextPageToken,2048);
        if(!page||ids.size>=100){truncated ||= Boolean(page);break;}
        if(count===2)truncated=true;
      }
      const result:GmailThread[]=[];const list=[...ids];
      for(let offset=0;offset<list.length;offset+=5){
        const batch=await Promise.all(list.slice(offset,offset+5).map(async threadId=>{
          const query=new URLSearchParams({format:'full',fields:'id,messages(id,snippet,internalDate,payload(headers(name,value)))'});
          return thread(await request(`${ROOT}/threads/${threadId}?${query}`,{method:'GET',headers},{signal}),email);
        }));
        result.push(...batch.filter((t):t is GmailThread=>t!==null));
      }
      return{threads:result.sort((a,b)=>b.lastMessageAt.localeCompare(a.lastMessageAt)||a.id.localeCompare(b.id)),truncated};
    },
    async watch({accessToken,topicName,...opt}){
      if(!/^projects\/[a-z][a-z0-9-]{4,61}[a-z0-9]\/topics\/[A-Za-z][A-Za-z0-9._~+%-]{2,254}$/.test(topicName))return invalidInput();
      const data=record(await request(`${ROOT}/watch`,{method:'POST',headers:{Authorization:bearer(accessToken),'Content-Type':'application/json'},body:JSON.stringify({topicName})},opt));
      const expiration=Number(decimal(data.expiration));if(!Number.isSafeInteger(expiration)||expiration>8640000000000000)return invalidResponse();
      return{historyId:decimal(data.historyId),expiration};
    },
    async stop(accessToken,opt={}){inputText(accessToken);await request(`${ROOT}/stop`,{method:'POST',headers:{Authorization:bearer(accessToken)}},opt);},
  };
}
