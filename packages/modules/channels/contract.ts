// Única puerta pública del módulo channels (SPEC §26).
export const MODULE_ID = 'channels' as const;
export {
  CHANNEL_KINDS,
  CHANNEL_STATES,
  assertChannelTransition,
  registerProvider,
  proveedorDe,
  resetProviders,
} from './domain/port';
export type {
  ChannelKind,
  ChannelState,
  ChannelProvider,
  ChannelAccountRef,
  OutboundMessage,
  NormalizedInbound,
  PuertoDePlantillas,
  PlantillaDelProveedor,
} from './domain/port';
export {
  createChannelAccount,
  findAccountById,
  tenantDeCuenta,
  setChannelState,
  listChannelAccounts,
  // Un aviso de cupo por día y por canal (#1248).
  avisarDelCupoUnaVezAlDia,
  // El arranque no levanta si una cuenta declara un proveedor sin adaptador (ADR-0032).
  proveedoresSinAdaptador,
  // Los proveedores con cuenta viva: la verdad de «este despliegue puede mandar»
  // cuando las llaves son por cuenta (#1338) y no hay variable global que mirar.
  proveedoresDeCuentas,
} from './application/accounts';
// El hilo de cada conversación del proveedor (ADR-0033, #1334).
export { hiloDe, olvidarHilo, recordarHilo, tomarCandadoDelHilo } from './application/hilos';
export type { ClaveDelHilo } from './application/hilos';
export { simuladorProvider, firmarWebhook } from './application/simulador';
// El rastro de los webhooks y por qué no llegan los mensajes (#434).
export { anotarWebhook, anotarEntrantesSinTelefono, rastroDeWebhook } from './application/rastro';
export { reservarEmisor, tenantDelEmisorDeCanal } from './application/senders';
export type { ResultadoDeWebhook, RastroDeWebhook } from './application/rastro';
export { diagnosticarCanal } from './application/diagnostico';
export type { Diagnostico, PasoDelDiagnostico, EstadoDelPaso } from './application/diagnostico';

// Los límites de un adjunto (#560): los declara el canal, y salen por acá para
// que la API y la interfaz usen la misma tabla y el mismo mensaje.
export {
  LIMITES_WHATSAPP,
  LIMITES_CONSERVADORES,
  limitesDelCanal,
  claseDeAdjunto,
  revisarAdjunto,
} from './domain/adjuntos';
export type { ClaseDeAdjunto, LimiteDeAdjunto, RevisionDeAdjunto } from './domain/adjuntos';

export { isChannelSecretRef } from './application/webhook-secret';
export {
  PREFIJO_CUSTODIA,
  type SecretoDelCanal,
  idDeSecretoDelCanal,
  referenciaEnCustodia,
  idEnLaReferencia,
  fijarSecretosDelCanal,
} from './application/secretos-en-custodia';

// El cupo diario del canal y la parte reservada a las personas (#1248).
//
// `TOPE_SI_NO_SE_SABE` y `RESERVA_PARA_PERSONAS` NO se publican: fuera de este
// módulo nadie decide con ellas —las aplica `cupoDelDia`, que es lo que sí
// viaja— y su prueba las importa del dominio. Un contrato que expone lo que
// nadie abre deja de ser una decisión (#664).
export {
  cupoDelDia,
  hayMargenParaUnAutomatismo,
  msHastaElReinicioDelCupo,
} from './domain/cupo-del-dia';
export type { CupoDelDia, CupoConfigurado } from './domain/cupo-del-dia';
