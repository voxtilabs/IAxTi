import { ModuleRegistry } from '@iaxti/core';

// El registry se construye una vez al arrancar; una validación fallida
// (ciclo, colisión, dependencia inexistente) aborta el proceso a propósito
// (SPEC §26). Vive en su propio archivo para que controllers y helpers lo
// importen sin ciclos con app.module.
export const registry = new ModuleRegistry().load();

// Contratos opcionales reales; capability devuelve null al apagar el módulo.
import { getConversation, mensajeRecibidoConAdjuntos } from '@iaxti/module-conversations';
import { getContactFicha, contactoAnonimizado } from '@iaxti/module-crm';
import { buscarDocumentoPersonal } from '@iaxti/module-knowledge';
registry.registerContract('conversations',{getConversation,mensajeRecibidoConAdjuntos});
registry.registerContract('crm',{getContactFicha,contactoAnonimizado});
registry.registerContract('knowledge',{buscarDocumentoPersonal});
