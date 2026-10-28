import { BadRequestException, Controller, Get, Header, HttpCode, HttpException, Inject, Post, Req, Res, SetMetadata } from '@nestjs/common';
import { ApiBody, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { Response } from 'express';
import { createQueue, redisConnection } from '@iaxti/core';
import { partnerPorts, partnerStatus, startPartnerInvitation, resumePartnerInvitation, receivePartnerWebhook, PartnerError, type PartnerPorts } from '@iaxti/module-whatsapp';
import { apiPool } from './db';
import { registry } from './registry';
import { RequireAuth, RequireModule, RequirePermission } from './authz/decorators';
import type { WithUser } from './authz/authz.guard';
import { Cuerpo } from './validar';
import { RESPUESTA_SENSIBLE } from './idempotencia.interceptor';

export const PARTNER_HTTP='PARTNER_HTTP';
let queue:ReturnType<typeof createQueue>|undefined;
export const partnerHttp={pool:apiPool,ports:():PartnerPorts=>partnerPorts(()=>registry.isActive('whatsapp')&&registry.isActive('channels')),
  async enqueue(data:{tenantId:string;invitationId:string;eventId:string}) {
    queue??=createQueue('inbound',redisConnection());
    await queue.add('whatsapp.partner',{...data,moduleId:'whatsapp'},{jobId:`partner-${data.tenantId}-${data.eventId}`});
  }};
const resume=z.strictObject({id:z.string().uuid()});
const empty=z.strictObject({});
function actor(req:WithUser) {const a=req.actor!;return {tenantId:a.tenantId,actor:a.userId,actorKind:a.kind==='apikey'?'apikey' as const:'user' as const,requestId:req.requestId};}
function pool(deps:typeof partnerHttp) {const value=deps.pool();if(!value)throw new PartnerError('DB_NOT_CONFIGURED','No pudimos abrir la conexión. Intenta más tarde.',503);return value;}
async function safe<T>(fn:()=>Promise<T>):Promise<T> {try{return await fn();}catch(e){if(e instanceof PartnerError)throw new HttpException({code:e.code,message:e.message},e.status);throw new HttpException({code:'PARTNER_UNAVAILABLE',message:'No pudimos completar la conexión. Revisa el estado y vuelve a intentar.'},503);}}
const schema={type:'object' as const,properties:{id:{type:'string' as const,nullable:true},phase:{type:'string' as const},providerStatus:{type:'string' as const,nullable:true},url:{type:'string' as const,nullable:true},expiresAt:{type:'string' as const,nullable:true},accountId:{type:'string' as const,nullable:true},errorCode:{type:'string' as const,nullable:true}}};
@ApiTags('onboarding')
@Controller('onboarding/whatsapp')
@RequireModule('whatsapp')
@RequireAuth({jwtOnly:true})
export class PartnerInvitationsController {
  constructor(@Inject(PARTNER_HTTP)private readonly deps:typeof partnerHttp){}
  @Get()
  @RequirePermission('whatsapp.numbers.manage')
  @Header('Cache-Control','no-store')
  @ApiOperation({summary:'Estado y enlace privado de la invitación de WhatsApp de mi negocio'})
  @ApiResponse({status:200,schema})
  status(@Req()req:WithUser){return safe(()=>partnerStatus(pool(this.deps),req.actor!.tenantId,this.deps.ports(),actor(req)));}

  @Post()
  @HttpCode(200)
  @RequirePermission('whatsapp.numbers.manage')
  @SetMetadata(RESPUESTA_SENSIBLE,true)
  @Header('Cache-Control','no-store')
  @ApiHeader({name:'Idempotency-Key',required:true,description:'Identifica el intento local. No se transmite como idempotencia inventada a Zavu.'})
  @ApiBody({schema:{type:'object',additionalProperties:false}})
  @ApiOperation({summary:'Crear una invitación de WhatsApp y guardar su correlación antes de mostrarla'})
  @ApiResponse({status:200,schema})
  start(@Req()req:WithUser,@Cuerpo(empty)_body:z.infer<typeof empty>){
    const key=req.headers['idempotency-key'];
    if(typeof key!=='string'||!key.trim()||key.length>255)throw new BadRequestException({code:'IDEMPOTENCY_KEY_REQUIRED',message:'Actualiza la página y vuelve a iniciar la conexión.'});
    return safe(()=>startPartnerInvitation(pool(this.deps),{...actor(req),key},this.deps.ports()));
  }
  @Post('retomar')
  @HttpCode(200)
  @RequirePermission('whatsapp.numbers.manage')
  @SetMetadata(RESPUESTA_SENSIBLE,true)
  @Header('Cache-Control','no-store')
  @ApiBody({schema:{type:'object',required:['id'],additionalProperties:false,properties:{id:{type:'string',format:'uuid'}}}})
  @ApiOperation({summary:'Revisar una invitación conocida o recuperar explícitamente una conexión pendiente'})
  @ApiResponse({status:200,schema:{type:'object',properties:{queued:{type:'boolean'}}}})
  resume(@Req()req:WithUser,@Cuerpo(resume)body:z.infer<typeof resume>){return safe(async()=>{
    const data=await resumePartnerInvitation(pool(this.deps),{...actor(req),...body},this.deps.ports());
    await this.deps.enqueue(data);return {queued:true};
  });}
}
@ApiTags('webhooks')
@Controller('webhooks/zavu/invitations')
@RequireModule('whatsapp')
export class PartnerWebhookController {
  constructor(@Inject(PARTNER_HTTP)private readonly deps:typeof partnerHttp){}
  @Post()
  @HttpCode(204)
  @ApiHeader({name:'X-Zavu-Signature',required:true})
  @ApiOperation({summary:'Verificar callback del proyecto Zavu y encolar su invitación correlacionada'})
  @ApiResponse({status:204,description:'Evento durable y encolado; el proveedor se procesa fuera de la solicitud.'})
  receive(@Req()req:WithUser&{rawBody?:Buffer},@Res({passthrough:true})res:Response) {res.setHeader('Retry-After','5');return safe(async()=>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{await Promise.race([
      (async()=>{const signature=req.headers['x-zavu-signature'];
        const data=await receivePartnerWebhook(pool(this.deps),req.rawBody?.toString('utf8')??'',typeof signature==='string'?signature:undefined,this.deps.ports());
        await this.deps.enqueue(data);
      })(),
      new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new PartnerError('PARTNER_DELIVERY_PENDING','Entrega pendiente. Reintenta el evento.',503)),800);timer.unref?.();}),
    ]);}finally{if(timer)clearTimeout(timer);}
  });}
}
