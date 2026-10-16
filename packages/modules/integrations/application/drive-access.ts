import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { ModuleRegistry } from '@iaxti/core';
import { roleOf, type GoogleGrant } from '@iaxti/module-identity';
import { baseRoleHasPermission, customRolePermissions, isBaseRole } from '@iaxti/module-authorization';
import { getTenant, modulosDelPlan } from '@iaxti/module-organizations';
import type * as Conversations from '@iaxti/module-conversations';
import type * as Crm from '@iaxti/module-crm';

export interface DriveContext {contactId?:string;conversationId?:string}
export const accountKey=(grant:GoogleGrant)=>createHash('sha256').update(`${grant.clientId}:${grant.subject}`).digest('hex');
export const denied=()=>new Error('No puedes usar estos archivos en este contexto. Revisa tus permisos y la conexión.');
export async function drivePermissions(c:PoolClient,input:{tenantId:string;userId:string},registry:ModuleRegistry):Promise<Set<string>> {
  const role=await roleOf(c,input.tenantId,input.userId);if(!role)throw denied();
  const catalog=new Set(registry.permissionsCatalog().keys());
  const permissions=isBaseRole(role)?[...catalog].filter(p=>baseRoleHasPermission(role,p,catalog)):
    (await customRolePermissions(c,input.tenantId,role)??[]).filter(p=>catalog.has(p));
  return new Set(permissions);
}
export async function authorizeDrive(c:PoolClient,input:{tenantId:string;userId:string},registry:ModuleRegistry,permission:string,write=false) {
  if(!registry.isActive('integrations'))throw denied();
  const permissions=await drivePermissions(c,input,registry);
  if(!permissions.has(permission))throw denied();
  const tenant=await getTenant(c,input.tenantId);
  if(!['active','trial','past_due','read_only'].includes(tenant.state))throw denied();
  if(write){
    const plan=await modulosDelPlan(c,input.tenantId);
    if(!['active','trial'].includes(tenant.state)||!plan.modulos?.includes('integrations'))throw denied();
  }
  return permissions;
}
export async function authorizeDriveContext(c:PoolClient,input:{tenantId:string;userId:string}&DriveContext,registry:ModuleRegistry,write=false){
  const permissions=await authorizeDrive(c,input,registry,write?'integrations.connect':'integrations.read',write);
  let contactId=input.contactId;
  if(input.conversationId){
    const conversations=registry.capability<typeof Conversations>('conversations');
    if(!conversations||!permissions.has('conversations.read'))throw denied();
    const conversation=await conversations.getConversation(c,input.tenantId,input.conversationId);
    if(conversation.ownerId&&conversation.ownerId!==input.userId&&!permissions.has('conversations.read_all'))throw denied();
    if(contactId&&contactId!==conversation.contactId)throw denied();
    contactId=conversation.contactId;
  }
  if(!contactId)throw denied();
  const crm=registry.capability<typeof Crm>('crm');
  if(!crm||!permissions.has('crm.contacts.read'))throw denied();
  if(await crm.contactoAnonimizado(c,input.tenantId,contactId,{bloquear:true}))throw denied();
  const {contact}=await crm.getContactFicha(c,input.tenantId,contactId);
  if(contact.owner_id&&contact.owner_id!==input.userId&&!permissions.has('crm.read_all'))throw denied();
  return {contactId,permissions,contactName:typeof contact.name==='string'?contact.name:'Contacto'};
}
