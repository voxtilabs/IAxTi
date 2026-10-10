export { ModuleRegistry, CORE_MODULES } from './registry';
export type { ModuleHealth } from './registry';
export { findModulesDir, loadManifest, loadAllManifests } from './manifest';
export type { ModuleManifest } from './manifest';
export { publishEvent, retryExhaustedEvent } from './events';
export type { EventEnvelope, PublishInput } from './events';
export { OutboxDispatcher, MAX_ATTEMPTS } from './dispatcher';
export type { Consumer, EventHandler } from './dispatcher';
export { QUEUE_NAMES, createQueue, createModuleWorker, redisConnection } from './queues';
export type { QueueName, ModuleJobData } from './queues';
export { attachmentKey, knowledgeKey, presignUrl, presignPutUrl, firmaPresignada, storageFromEnv, almacenR2 } from './storage';
export type { StorageConfig, LimitesSubida, AlmacenObjetos } from './storage';
export { diaEn, mesEn, ultimosDias, esDia, TZ_POR_DEFECTO } from './dias';
export {
  reservarLlave,
  guardarRespuesta,
  soltarLlave,
  limpiarLlavesVencidas,
  huellaDelPedido,
} from './idempotencia';
export type { Reserva } from './idempotencia';
export { crearZip, crc32 } from './zip';
export type { ArchivoZip } from './zip';
// Un xlsx es un zip con XML, así que vive al lado del zip (#709).
// Caché de lecturas: Redis está a 0 ms y la base a 64 ms (#711).
export { leerConCache, olvidarEnCache, olvidarEnTodosLosTenants, claveDeCache } from './cache';
export type { OpcionesDeCache } from './cache';
export { crearXlsx, referencia } from './xlsx';
export type { HojaXlsx, ColumnaXlsx, ValorCelda } from './xlsx';
export { enteroDeEntorno, textoDeEntorno, entornoDesplegado, esProduccion } from './entorno';
export { consumerReadiness } from './consumer-readiness';
// Qué build está corriendo (#565): el SHA sale del tag de IAXTI_IMAGE.
export { versionDelBuild } from './version';
export type { VersionDelBuild } from './version';

// El lector del compose. Se exporta para que un módulo con lecturas DINÁMICAS de
// `process.env` pueda traer su propia guarda (#633): el escáner general solo ve
// `process.env.X`, así que el dueño de la lectura es el dueño de su guarda.
export {
  variablesQueEntregaElCompose,
  variablesQueLeeElCodigo,
  type LecturaDeVariable,
} from './variables-del-despliegue';

// Qué publica cada módulo y quién lo usa (#664). Se exporta para que la guarda
// pueda leerlo; no lo usa nada en producción, y eso está escrito en su lista.
export { exportsSinConsumidor, valoresQuePublica } from './exports-sin-consumidor';
export { entornoConCoalescencia } from './entorno-con-coalescencia';
export type { LecturaConCoalescencia } from './entorno-con-coalescencia';
// Columnas que se escriben y nadie lee, con trinquete (#703). La familia de
// autores (#697) es el mismo escáner con un filtro: `ES_DE_AUTOR`.
export {
  columnasDeclaradas,
  columnasSinLector,
  lecturasPorTabla,
  enCamello,
  ES_DE_AUTOR,
} from './columnas-sin-lector';
export type { Columna } from './columnas-sin-lector';
// Barridos que recorren todos los tenants, con trinquete (#743).
export { barridosDelRepo, llamadasDeBarrido } from './barridos-sin-lista';
export type { LlamadaDeBarrido } from './barridos-sin-lista';
