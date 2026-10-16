import {BadRequestException,Body,Controller,ForbiddenException,Get,Header,HttpCode,Inject,Post,Query,Req,Res,ServiceUnavailableException,SetMetadata,UnauthorizedException} from '@nestjs/common';
import {ApiBody,ApiHeader,ApiOperation,ApiQuery,ApiResponse,ApiTags} from '@nestjs/swagger';
import type {SchemaObject} from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import type {Response} from 'express';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {createQueue,redisConnection} from '@iaxti/core';
import {estadoGmail,iniciarGmail,completarGmail,revocarGmail,hilosGmail,autenticarPushGmail,gmailDesdeEntorno,GmailAccessError,type GmailPush} from '@iaxti/module-integrations';
import {getContactMailAccess,contactoAnonimizado} from '@iaxti/module-crm';
import {RequireAuth,RequireModule,RequirePermission} from './authz/decorators';
import type {WithUser} from './authz/authz.guard';
import type {WithRequestId} from './request-id';
import {apiPool} from './db';
import {registry} from './registry';
import {Cuerpo,validar} from './validar';
import {RESPUESTA_SENSIBLE} from './idempotencia.interceptor';
export const GMAIL_HTTP='GMAIL_HTTP';
let queue:ReturnType<typeof createQueue>|undefined;
export const gmailHttp={pool:apiPool,google:gmailDesdeEntorno,context:{registry,contact:async(c:PoolClient,t:string,id:string)=>await contactoAnonimizado(c,t,id,{bloquear:true})?null:getContactMailAccess(c,t,id)},async enqueue(data:GmailPush&{requestId?:string}){
  queue??=createQueue('inbound',redisConnection());await queue.add('gmail.push',{...data,moduleId:'integrations'},{jobId:`gmail-${data.messageId}`});
}};
export type GmailHttp=typeof gmailHttp;
const start=z.object({challenge:z.string().regex(/^[A-Za-z0-9_-]{43}$/)}).strict();
const finish=z.object({state:z.string().regex(/^[A-Za-z0-9_-]{43}$/),nonce:z.string().regex(/^[A-Za-z0-9_-]{43}$/),verifier:z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),code:z.string().min(1).max(8192).regex(/^[^\r\n\0]+$/)}).strict();
const list=z.object({contactId:z.string().uuid(),refresh:z.enum(['true','false']).optional()}).strict();
function pool(d:GmailHttp){const p=d.pool();if(!p)throw new ServiceUnavailableException({code:'DB_NOT_CONFIGURED',message:'No pudimos abrir la conexión. Intenta más tarde.'});return p;}
function actor(r:WithUser){return{tenantId:r.actor!.tenantId,userId:r.actor!.userId};}
function failed(e:unknown):never{
  if(e instanceof GmailAccessError)throw new ForbiddenException({code:e.code,message:e.message});
  throw new BadRequestException({code:'GMAIL_FAILED',message:'No pudimos consultar Gmail. Revisa el permiso de Google y vuelve a intentar.'});
}
@ApiTags('integrations')
@Controller('integraciones/gmail')
@RequireModule('integrations')
@RequireAuth({jwtOnly:true})
export class GmailController{
  constructor(@Inject(GMAIL_HTTP)private readonly deps:GmailHttp){}
  @Get()
  @RequirePermission('integrations.read')
  @Header('Cache-Control','no-store')
  @ApiOperation({summary:'Estado de mi conexión de Gmail'})
  async estado(@Req()r:WithUser){try{return await estadoGmail(pool(this.deps),actor(r),this.deps.context,this.deps.google());}catch(e){return failed(e);}}
  @Post('iniciar')
  @HttpCode(200)
  @RequirePermission('integrations.connect')
  @Header('Cache-Control','no-store')
  @SetMetadata(RESPUESTA_SENSIBLE,true)
  @ApiBody({schema:z.toJSONSchema(start,{target:'openapi-3.0'}) as SchemaObject})
  @ApiOperation({summary:'Autorizar lectura de mi Gmail con consentimiento incremental y PKCE'})
  async iniciar(@Req()r:WithUser,@Cuerpo(start)b:z.infer<typeof start>){try{return await iniciarGmail(pool(this.deps),{...actor(r),...b},this.deps.context,this.deps.google());}catch(e){return failed(e);}}
  @Post('completar')
  @HttpCode(200)
  @RequirePermission('integrations.connect')
  @Header('Cache-Control','no-store')
  @ApiBody({schema:z.toJSONSchema(finish,{target:'openapi-3.0'}) as SchemaObject})
  @ApiOperation({summary:'Guardar el permiso de lectura de Gmail de esta sesión'})
  async completar(@Req()r:WithUser,@Cuerpo(finish)b:z.infer<typeof finish>){try{return await completarGmail(pool(this.deps),{...actor(r),...b},this.deps.context,this.deps.google());}catch(e){return failed(e);}}
  @Post('revocar')
  @HttpCode(200)
  @RequirePermission('integrations.connect')
  @Header('Cache-Control','no-store')
  @ApiOperation({summary:'Revocar todos los permisos Google concedidos a esta aplicación'})
  async revocar(@Req()r:WithUser){try{return await revocarGmail(pool(this.deps),actor(r),this.deps.context,this.deps.google());}catch(e){return failed(e);}}
  @Get('hilos')
  @RequirePermission('integrations.read')
  @Header('Cache-Control','no-store')
  @ApiQuery({name:'contactId',required:true,type:String,description:'UUID del contacto CRM; el correo se obtiene en servidor.'})
  @ApiQuery({name:'refresh',required:false,enum:['true','false'],description:'Lectura explícita fresca; recupera una notificación perdida.'})
  @ApiOperation({summary:'Leer los hilos de mi Gmail con el correo exacto del contacto: asunto y extracto, sin cuerpos ni envío'})
  async get_threads(@Req()r:WithUser,@Query()query:unknown){
    const input=validar(list,query);
    try{return await hilosGmail(pool(this.deps),{...actor(r),contactId:input.contactId,refresh:input.refresh==='true'},this.deps.context,this.deps.google());}catch(e){return failed(e);}
  }
}
@ApiTags('webhooks')
@Controller('webhooks/google/gmail')
@RequireModule('integrations')
export class GmailWebhookController{
  constructor(@Inject(GMAIL_HTTP)private readonly deps:GmailHttp){}
  @Post()
  @HttpCode(204)
  @ApiHeader({name:'Authorization',required:true,description:'OIDC firmado por Google para la cuenta de servicio y audiencia configuradas.'})
  @ApiBody({schema:{type:'object',required:['subscription','message'],properties:{subscription:{type:'string'},message:{type:'object',required:['data','messageId'],properties:{data:{type:'string'},messageId:{type:'string'}}}}}})
  @ApiOperation({summary:'Verificar push Gmail de Pub/Sub, encolar e invalidar caché personal'})
  @ApiResponse({status:204,description:'Notificación autenticada y encolada de forma durable.'})
  async recibir(@Req()r:WithRequestId,@Body()body:unknown,@Res({passthrough:true})res:Response){
    const token=typeof r.headers.authorization==='string'&&r.headers.authorization.startsWith('Bearer ')?r.headers.authorization.slice(7):'';
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{await Promise.race([(async()=>{
      let push:GmailPush;try{push=await autenticarPushGmail(token,body,this.deps.google());}catch{throw new UnauthorizedException({code:'GOOGLE_PUSH_INVALID',message:'No pudimos validar esta notificación.'});}
      await this.deps.enqueue({...push,requestId:r.requestId});
    })(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error()),800);timer.unref?.();})]);}
    catch(e){if(e instanceof UnauthorizedException)throw e;res.setHeader('Retry-After','5');throw new ServiceUnavailableException({code:'GOOGLE_PUSH_RETRY',message:'No pudimos guardar la notificación. Reintenta en unos segundos.'});}
    finally{clearTimeout(timer);}
  }
}
