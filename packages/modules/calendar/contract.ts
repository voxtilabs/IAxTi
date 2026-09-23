// Única puerta pública del módulo calendar (SPEC §26).
export const MODULE_ID = 'calendar' as const;
export {
  definirDisponibilidad,
  listarDisponibilidad,
  quitarDisponibilidad,
  huecosDelDia,
  agendar,
  cambiarEstadoCita,
  listarCitas,
} from './application/agenda';
export type { Disponibilidad, HuecoOfrecido, Cita } from './application/agenda';
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
