import { ModuleRegistry } from '@iaxti/core';

// El registry se construye una vez al arrancar; una validación fallida
// (ciclo, colisión, dependencia inexistente) aborta el proceso a propósito
// (SPEC §26). Vive en su propio archivo para que controllers y helpers lo
// importen sin ciclos con app.module.
export const registry = new ModuleRegistry().load();
