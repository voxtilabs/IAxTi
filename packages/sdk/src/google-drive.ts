import { googleDriveRoutes } from './google-drive-routes.generated';
export interface GoogleDriveState { configured:boolean;status:'disconnected'|'active'|'reauth_required'|'revoking'|'revoked' }
export interface DriveContext {contactId?:string;conversationId?:string}
export interface PersonalDriveFile {id:string;fileId:string;name:string;mimeType:string;url:string;aiAllowed:boolean}
export interface DriveSearchResult {files:Array<PersonalDriveFile & {available:boolean;knowledgeReadable:boolean;passages:Array<{text:string;part:number;citation:string}>}>;knowledgeAvailable:boolean;truncated:boolean;nextCursor:string|null}
export interface DriveFolderState {enabled:boolean;pending:number;retrying:number;uploaded:number;lastUploadedAt:string|null;nextAttemptAt:string|null;folderUrl:string|null}
export interface DriveReference {id:string;selectedId:string|null;name:string;mimeType:string;url:string;own:boolean}
export class GoogleDriveSdkError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number, public readonly requestId: string) { super(message); }
}
/** Rutas generadas del contrato OpenAPI; ninguna credencial Google llega al SDK. */
export function googleDriveClient(config: { apiUrl: string; token: string; tenantId: string }) {
  async function call<T>(operation: keyof typeof googleDriveRoutes, body?: unknown, key?: string): Promise<T> {
    const route = googleDriveRoutes[operation];
    const response = await fetch(`${config.apiUrl.replace(/\/$/, '')}${route.path}`, {
      method: route.method, cache: 'no-store', referrerPolicy: 'no-referrer',
      headers: { Authorization: `Bearer ${config.token}`, 'X-Tenant-Id': config.tenantId,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(key ? { 'Idempotency-Key': key } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result) throw new GoogleDriveSdkError(result?.code ?? 'GOOGLE_REQUEST_FAILED',
      result?.message ?? 'No pudimos consultar la conexión con Google. Intenta otra vez.', response.status, result?.requestId ?? '');
    return result as T;
  }
  return {
    state:()=>call<GoogleDriveState>('DriveController_estado'),
    start:(challenge:string)=>call<{state:string;nonce:string;url:string}>('DriveController_iniciar',{challenge}),
    finish:(body:{code:string;state:string;nonce:string;verifier:string},key:string)=>call<GoogleDriveState>('DriveController_completar',body,key),
    revoke:(key:string)=>call<{revoked:true}>('DriveController_revocar',undefined,key),
    picker:()=>call<{clientId:string;apiKey:string;appId:string}>('DriveController_selector'),
    select:(fileId:string,key:string)=>call<PersonalDriveFile>('DriveController_seleccionar',{fileId,aiAllowed:false},key),
    allowAi:(id:string,allowed:boolean,key:string)=>call<PersonalDriveFile>('DriveController_permisoIa',{id,allowed},key),
    search:(body:{query:string;context?:DriveContext;readDocuments?:boolean;after?:string})=>call<DriveSearchResult>('DriveController_search',body),
    attach:(id:string,context:DriveContext,key:string)=>call<{attached:true;created:boolean}>('DriveController_attach',{id,context},key),
    references:(context:DriveContext)=>call<DriveReference[]>('DriveController_adjuntos',{context}),
    folder:(contactId:string)=>call<DriveFolderState>('DriveController_estadoCarpeta',{contactId}),
    configureFolder:(contactId:string,enabled:boolean,key:string)=>call<{enabled:boolean}>('DriveController_carpeta',{contactId,enabled},key),
  };
}
