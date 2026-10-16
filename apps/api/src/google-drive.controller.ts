import { BadRequestException,Controller,Get,Header,HttpCode,Inject,Post,Req,ServiceUnavailableException,SetMetadata } from '@nestjs/common';
import { ApiBody,ApiOperation,ApiTags } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { z } from 'zod';
import { estadoDrive,iniciarDrive,completarDrive,revocarDrive,prepararPickerDrive,seleccionarArchivoDrive,permitirIaDrive,buscarDrive,adjuntarDrive,adjuntosDrive,
  configurarCarpetaDrive,estadoCarpetaDrive,driveDesdeEntorno } from '@iaxti/module-integrations';
import { RequireAuth,RequireModule,RequirePermission } from './authz/decorators';
import type { WithUser } from './authz/authz.guard';
import { apiPool } from './db';
import { registry } from './registry';
import { Cuerpo } from './validar';
import { RESPUESTA_SENSIBLE } from './idempotencia.interceptor';

export const GOOGLE_DRIVE_HTTP='GOOGLE_DRIVE_HTTP';
export const googleDriveHttp={pool:apiPool,deps:()=>driveDesdeEntorno(registry),registry};
const context=z.object({contactId:z.uuid().optional(),conversationId:z.uuid().optional()}).strict().refine(v=>Boolean(v.contactId||v.conversationId),'Elige una conversación o contacto.');
const start=z.object({challenge:z.string().regex(/^[A-Za-z0-9_-]{43}$/)}).strict();
const finish=z.object({state:z.string().regex(/^[A-Za-z0-9_-]{43}$/),nonce:z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  verifier:z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),code:z.string().min(1).max(8192).regex(/^[^\r\n\0]+$/)}).strict();
const select=z.object({fileId:z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),aiAllowed:z.boolean().default(false)}).strict();
const permission=z.object({id:z.uuid(),allowed:z.boolean()}).strict();
const search=z.object({query:z.string().max(200).default(''),context:context.optional(),readDocuments:z.boolean().default(false),after:z.uuid().optional()}).strict();
const attach=z.object({id:z.uuid(),context}).strict();
const references=z.object({context}).strict();
const folder=z.object({contactId:z.uuid(),enabled:z.boolean()}).strict();
const folderState=z.object({contactId:z.uuid()}).strict();
const schema=(value:z.ZodType)=>z.toJSONSchema(value,{target:'openapi-3.0'}) as SchemaObject;
const actor=(r:WithUser)=>({tenantId:r.actor!.tenantId,userId:r.actor!.userId});
@ApiTags('integrations')
@Controller('integraciones/drive')
@RequireModule('integrations')
@RequireAuth({jwtOnly:true})
export class DriveController {
  constructor(@Inject(GOOGLE_DRIVE_HTTP)private readonly http:typeof googleDriveHttp){}
  private pool(){const value=this.http.pool();if(!value)throw new ServiceUnavailableException({code:'DB_NOT_CONFIGURED',message:'No pudimos abrir la conexión. Intenta más tarde.'});return value;}
  private deps(){const value=this.http.deps();if(!value)throw new ServiceUnavailableException({code:'DRIVE_NOT_CONFIGURED',message:'Google Drive aún no está configurado. Contacta al administrador.'});return value;}
  private async run<T>(fn:()=>Promise<T>){try{return await fn();}catch(error){if(error instanceof ServiceUnavailableException)throw error;throw new BadRequestException({code:'DRIVE_FAILED',message:'No pudimos completar la acción. Revisa tus permisos, el archivo y la conexión con Google Drive.'});}}
  @Get()
  @RequirePermission('integrations.read')
  @Header('Cache-Control','no-store')
  @ApiOperation({summary:'Estado de mi conexión personal a Google Drive'})
  estado(@Req()r:WithUser){return this.run(()=>estadoDrive(this.pool(),actor(r),this.http.registry,this.http.deps()));}
  @Post('iniciar')
  @HttpCode(200)
  @RequirePermission('integrations.connect')
  @Header('Cache-Control','no-store')
  @SetMetadata(RESPUESTA_SENSIBLE,true)
  @ApiBody({schema:schema(start)})
  @ApiOperation({summary:'Iniciar consentimiento personal incremental de Drive con PKCE'})
  iniciar(@Req()r:WithUser,@Cuerpo(start)b:z.infer<typeof start>){return this.run(()=>iniciarDrive(this.pool(),{...actor(r),...b},this.deps()));}
  @Post('completar')
  @HttpCode(200)
  @RequirePermission('integrations.connect')
  @Header('Cache-Control','no-store')
  @ApiBody({schema:schema(finish)})
  @ApiOperation({summary:'Completar una vez el consentimiento personal de Drive'})
  completar(@Req()r:WithUser,@Cuerpo(finish)b:z.infer<typeof finish>){return this.run(()=>completarDrive(this.pool(),{...actor(r),...b},this.deps()));}
  @Post('revocar')
  @HttpCode(200)
  @RequirePermission('integrations.connect')
  @Header('Cache-Control','no-store')
  @ApiOperation({summary:'Revocar todos los servicios de la cuenta Google conectada'})
  revocar(@Req()r:WithUser){return this.run(()=>revocarDrive(this.pool(),actor(r),this.deps()));}
  @Post('selector')
  @HttpCode(200)
  @RequirePermission('integrations.connect')
  @Header('Cache-Control','no-store')
  @SetMetadata(RESPUESTA_SENSIBLE,true)
  @ApiOperation({summary:'Abrir el selector oficial con configuración pública, sin tokens del servidor'})
  selector(@Req()r:WithUser){return this.run(()=>prepararPickerDrive(this.pool(),actor(r),this.deps()));}
  @Post('seleccionar')
  @Header('Cache-Control','no-store')
  @SetMetadata(RESPUESTA_SENSIBLE,true)
  @HttpCode(200)
  @RequirePermission('integrations.connect')
  @ApiBody({schema:schema(select)})
  @ApiOperation({summary:'Autorizar un archivo seleccionado de mi Drive, verificándolo en Google'})
  seleccionar(@Req()r:WithUser,@Cuerpo(select)b:z.infer<typeof select>){return this.run(()=>seleccionarArchivoDrive(this.pool(),{...actor(r),...b},this.deps()));}
  @Post('permiso-ia')
  @Header('Cache-Control','no-store')
  @SetMetadata(RESPUESTA_SENSIBLE,true)
  @HttpCode(200)
  @RequirePermission('integrations.connect')
  @ApiBody({schema:schema(permission)})
  @ApiOperation({summary:'Permitir o retirar lectura por IA de un documento personal autorizado'})
  permisoIa(@Req()r:WithUser,@Cuerpo(permission)b:z.infer<typeof permission>){return this.run(()=>permitirIaDrive(this.pool(),{...actor(r),...b},this.deps()));}
  @Post('buscar')
  @HttpCode(200)
  @RequirePermission('integrations.read')
  @Header('Cache-Control','no-store')
  @SetMetadata(RESPUESTA_SENSIBLE,true)
  @ApiBody({schema:schema(search)})
  @ApiOperation({operationId:'DriveController_search',summary:'Buscar archivos personales autorizados en Drive y pasajes permitidos para IA'})
  search(@Req()r:WithUser,@Cuerpo(search)b:z.infer<typeof search>){return this.run(()=>buscarDrive(this.pool(),{...actor(r),...b},this.deps()));}
  @Post('adjuntar')
  @HttpCode(200)
  @RequirePermission('integrations.connect')
  @ApiBody({schema:schema(attach)})
  @ApiOperation({operationId:'DriveController_attach',summary:'Adjuntar una referencia de Drive a una conversación o ficha sin enviar ni cambiar permisos Google'})
  attach(@Req()r:WithUser,@Cuerpo(attach)b:z.infer<typeof attach>){return this.run(()=>adjuntarDrive(this.pool(),{...actor(r),...b},this.deps()));}
  @Post('adjuntos')
  @HttpCode(200)
  @RequirePermission('integrations.read')
  @Header('Cache-Control','no-store')
  @SetMetadata(RESPUESTA_SENSIBLE,true)
  @ApiBody({schema:schema(references)})
  @ApiOperation({summary:'Ver las referencias de Drive publicadas en esta conversación o ficha'})
  adjuntos(@Req()r:WithUser,@Cuerpo(references)b:z.infer<typeof references>){return this.run(()=>adjuntosDrive(this.pool(),{...actor(r),...b},this.http.registry));}
  @Post('carpeta')
  @HttpCode(200)
  @RequirePermission('integrations.connect')
  @ApiBody({schema:schema(folder)})
  @ApiOperation({summary:'Activar o detener las copias de nuevos adjuntos recibidos por este contacto'})
  carpeta(@Req()r:WithUser,@Cuerpo(folder)b:z.infer<typeof folder>){return this.run(()=>configurarCarpetaDrive(this.pool(),{...actor(r),...b},this.deps()));}
  @Post('carpeta/estado')
  @HttpCode(200)
  @RequirePermission('integrations.read')
  @Header('Cache-Control','no-store')
  @SetMetadata(RESPUESTA_SENSIBLE,true)
  @ApiBody({schema:schema(folderState)})
  @ApiOperation({summary:'Ver el estado de mis copias de adjuntos por contacto'})
  estadoCarpeta(@Req()r:WithUser,@Cuerpo(folderState)b:z.infer<typeof folderState>){return this.run(()=>estadoCarpetaDrive(this.pool(),{...actor(r),...b},this.deps()));}
}
