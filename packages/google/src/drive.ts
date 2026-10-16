import { createHash } from 'node:crypto';
import {
  bearer, createTransport, createResponseTransport, GoogleIntegrationError, inputText,
  invalidInput, invalidResponse, record, text, type GoogleRequestOptions, type GoogleTransportOptions,
} from './http';

const FILES='https://www.googleapis.com/drive/v3/files';
const UPLOAD='https://www.googleapis.com/upload/drive/v3/files';
const FIELDS='id,name,mimeType,webViewLink,size,md5Checksum,modifiedTime,trashed,capabilities(canDownload),parents,appProperties';
const FOLDER='application/vnd.google-apps.folder';
/** Mismo máximo que un documento recibido por WhatsApp. */
export const GOOGLE_DRIVE_MAX_UPLOAD_BYTES=100*1024*1024;
export const GOOGLE_DRIVE_MAX_READ_BYTES=10*1024*1024;
export interface GoogleDriveFile {
  id:string;name:string;mimeType:string;webViewLink:string;size:number|null;modifiedTime:string|null;
  md5Checksum:string|null;trashed:boolean;canDownload:boolean;parents:string[];appProperties:Record<string,string>;
}
interface DriveRequest extends GoogleRequestOptions {accessToken:string}
export interface GoogleDriveClient {
  get(input:DriveRequest & {fileId:string}):Promise<GoogleDriveFile>;
  read(input:DriveRequest & {fileId:string;mimeType:string;maxBytes?:number}):Promise<{bytes:Uint8Array;mimeType:string}>;
  generateId(input:DriveRequest):Promise<string>;
  createFolder(input:DriveRequest & {fileId:string;name:string;marker:string}):Promise<GoogleDriveFile>;
  upload(input:DriveRequest & {fileId:string;folderId:string;name:string;mimeType:string;bytes:Uint8Array;marker:string}):Promise<GoogleDriveFile>;
}
function id(value:string){if(!/^[A-Za-z0-9_-]{1,200}$/.test(value))return invalidInput();return value;}
function metadata(raw:unknown):GoogleDriveFile {
  const value=record(raw);const fileId=id(text(value.id,200));
  const link=value.webViewLink===undefined ? `https://drive.google.com/file/d/${fileId}/view` : text(value.webViewLink,2048);
  let url:URL;try{url=new URL(link);}catch{return invalidResponse();}
  if(url.protocol!=='https:'||!['drive.google.com','docs.google.com'].includes(url.hostname)||url.username||url.password)return invalidResponse();
  const size=value.size===undefined?null:Number(value.size);
  if(size!==null&&(!Number.isSafeInteger(size)||size<0))return invalidResponse();
  const checksum=value.md5Checksum??null;if(checksum!==null&&(typeof checksum!=='string'||! /^[0-9a-f]{32}$/.test(checksum)))return invalidResponse();
  const parents=value.parents===undefined?[]:value.parents;
  if(!Array.isArray(parents)||parents.some(parent=>typeof parent!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(parent)))return invalidResponse();
  const properties=value.appProperties===undefined?{}:record(value.appProperties);
  if(Object.values(properties).some(v=>typeof v!=='string'))return invalidResponse();
  return {id:fileId,name:text(value.name,1024),mimeType:text(value.mimeType,255),webViewLink:url.href,size,
    md5Checksum:checksum as string|null,modifiedTime:value.modifiedTime===undefined?null:text(value.modifiedTime,80),trashed:value.trashed===true,
    canDownload:value.capabilities!==undefined&&record(value.capabilities).canDownload===true,
    parents:parents as string[],appProperties:properties as Record<string,string>};
}
export function createGoogleDriveClient(options:GoogleTransportOptions={}):GoogleDriveClient {
  const request=createTransport(options);const response=createResponseTransport(options);
  const headers=(token:string)=>({Authorization:bearer(token)});
  const parse=async(operation:Promise<unknown>,fileId:string)=>{const file=metadata(await operation);if(file.id!==fileId)return invalidResponse();return file;};
  return {
    get({accessToken,fileId,...opt}){
      return parse(request(`${FILES}/${id(fileId)}?fields=${encodeURIComponent(FIELDS)}&supportsAllDrives=true`,{headers:headers(accessToken)},opt),fileId);
    },
    async read({accessToken,fileId,mimeType,maxBytes=GOOGLE_DRIVE_MAX_READ_BYTES,...opt}){
      id(fileId);const exports:Record<string,string>={
        'application/vnd.google-apps.document':'text/plain',
        'application/vnd.google-apps.spreadsheet':'text/csv',
        'application/vnd.google-apps.presentation':'text/plain',
      };
      const exported=exports[mimeType];
      if(!exported&&!['text/plain','text/markdown','text/csv','application/pdf'].includes(mimeType))return invalidInput();
      const url=exported?`${FILES}/${fileId}/export?mimeType=${encodeURIComponent(exported)}`:`${FILES}/${fileId}?alt=media&supportsAllDrives=true`;
      const result=await response(url,{headers:headers(accessToken)},{...opt,maxBytes:Math.min(maxBytes,GOOGLE_DRIVE_MAX_READ_BYTES)});
      return {bytes:result.bytes,mimeType:exported??mimeType};
    },
    async generateId({accessToken,...opt}){
      const result=record(await request(`${FILES}/generateIds?count=1&space=drive&type=files`,{headers:headers(accessToken)},opt));
      if(!Array.isArray(result.ids)||result.ids.length!==1)return invalidResponse();return id(text(result.ids[0],200));
    },
    async createFolder({accessToken,fileId,name,marker,...opt}){
      const body={id:id(fileId),name:inputText(name,1024),mimeType:FOLDER,appProperties:{iaxti:inputText(marker,120)}};
      try{return await parse(request(`${FILES}?fields=${encodeURIComponent(FIELDS)}`,{method:'POST',headers:{...headers(accessToken),'Content-Type':'application/json'},body:JSON.stringify(body)},opt),fileId);}
      catch(error){
        if(!(error instanceof GoogleIntegrationError&&error.status===409))throw error;
        const existing=await this.get({accessToken,fileId,...opt});
        if(existing.mimeType!==FOLDER||existing.trashed||existing.appProperties.iaxti!==marker)return invalidResponse();
        return existing;
      }
    },
    async upload({accessToken,fileId,folderId,name,mimeType,bytes,marker,...opt}){
      id(fileId);id(folderId);inputText(name,1024);inputText(marker,120);
      if(!/^[a-zA-Z0-9.+_-]+\/[a-zA-Z0-9.+_-]+$/.test(mimeType)||mimeType.startsWith('application/vnd.google-apps.')
        ||!bytes.byteLength||bytes.byteLength>GOOGLE_DRIVE_MAX_UPLOAD_BYTES)return invalidInput();
      const body={id:fileId,name,mimeType,parents:[folderId],appProperties:{iaxti:marker}};
      try{
        const session=await response(`${UPLOAD}?uploadType=resumable&fields=${encodeURIComponent(FIELDS)}`,{
          method:'POST',headers:{...headers(accessToken),'Content-Type':'application/json','X-Upload-Content-Type':mimeType,'X-Upload-Content-Length':String(bytes.byteLength)},body:JSON.stringify(body)},opt);
        const location=session.headers.get('location');let url:URL;try{url=new URL(location??'');}catch{return invalidResponse();}
        // La sesión es una credencial efímera: no se devuelve, registra ni persiste.
        if(url.origin!=='https://www.googleapis.com'||url.pathname!=='/upload/drive/v3/files'||url.username||url.password||url.hash
          ||url.searchParams.get('uploadType')!=='resumable'||!url.searchParams.get('upload_id'))return invalidResponse();
        return await parse(request(url.href,{method:'PUT',headers:{...headers(accessToken),'Content-Type':mimeType,'Content-Length':String(bytes.byteLength)},body:new Uint8Array(bytes)},opt),fileId);
      }catch(error){
        if(!(error instanceof GoogleIntegrationError&&error.status===409))throw error;
        const existing=await this.get({accessToken,fileId,...opt});
        if(existing.trashed||existing.appProperties.iaxti!==marker||!existing.parents.includes(folderId)||existing.size!==bytes.byteLength||existing.md5Checksum!==createHash('md5').update(bytes).digest('hex'))return invalidResponse();
        return existing;
      }
    },
  };
}
