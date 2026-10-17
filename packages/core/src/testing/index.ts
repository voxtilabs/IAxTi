// Lo que las pruebas de otros paquetes importan como `@iaxti/core/testing`.
//
// Era un solo archivo apuntado directo desde `exports`. Al segundo ayudante
// —`outboxAcotado`, #972— eso obligaba a elegir cuál de los dos se podía
// importar, así que acá está el barril y el `exports` apunta a él. Los
// `import { fuenteLimpia } from '@iaxti/core/testing'` que ya existen siguen
// funcionando igual.
export { fuenteLimpia } from './fuente-limpia';
export { outboxAcotado } from './outbox-acotado';
