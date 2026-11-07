// Única puerta pública del módulo calendar (SPEC §26).
export const MODULE_ID = 'calendar' as const;
export {
  definirDisponibilidad,
  listarDisponibilidad,
  quitarDisponibilidad,
  huecosDelDia,
  agendar,
  cambiarEstadoCita,
  reagendarCita,
  listarCitas,
  // Por qué se nos cancelan las visitas, y qué quedó vivo en Google (#700).
  motivosDeCancelacion,
  citasDesincronizadasConGoogle,
  // Las citas que quedan dentro de un cierre, para avisar sin cancelar (#1281).
  citasDentroDelCierre,
} from './application/agenda';
export type {
  Disponibilidad,
  HuecoOfrecido,
  Cita,
  AgendaDeps,
  CancelarEnGoogle,
  MoverEnGoogle,
  MotivoDeCancelacion,
} from './application/agenda';
// Los días que el negocio no abre: feriados, vacaciones (#1281).
//
// `diaCerrado` NO se publica: lo consume `huecosDelDia` dentro del módulo, y
// un contrato que expone lo que nadie abre deja de ser una decisión (#664).
export { cierrePorId, cerrarDias, listarCierres, abrirDias } from './application/cierres';
export type { Cierre } from './application/cierres';
export { ESTADOS_CITA, assertTransicionCita, ocupaAgenda } from './domain/estado';
export type { EstadoCita } from './domain/estado';
export { huecosLibres, comoHora, desdeHora } from './domain/horarios';
export type { VentanaDelDia, Ocupado } from './domain/horarios';
export {
  citasPorRecordar,
  marcarAvisoEnviado,
  barrerRecordatorios,
  AVISOS,
} from './application/recordatorios';
export type { CitaPorRecordar, AvisoId } from './application/recordatorios';
// Con qué plantilla sale cada recordatorio, y cómo se le dice la hora (#59).
export { configuracionDeAvisos, cuandoEnPalabras, valoresDelAviso } from './domain/aviso';
export type { ConfiguracionDeAvisos } from './domain/aviso';

export { estadoGoogleCalendar, iniciarGoogleCalendar, completarGoogleCalendar, revocarGoogleCalendar,
  mantenerWatchesGoogle, limpiarSecretosGoogle,
  autenticarPushGoogle, procesarPushGoogle, huecosConGoogle } from './application/google';
