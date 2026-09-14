// Las métricas v1 (#66, SPEC §19): cada número con su DEFINICIÓN — sin
// métricas inventadas ni proyecciones. Lo que un módulo apagado no puede
// medir, aparece en cero con su explicación, jamás adivinado.

export const METRICS = [
  'conversaciones_nuevas',
  'resueltas',
  'oportunidades_creadas',
  'ganadas',
  'perdidas',
  'valor_ganado_clp',
  'ia_ejecuciones',
  'ia_costo_usd',
  'mensajes_enviados',
  'costo_meta_usd',
  'citas_agendadas',
  'citas_asistidas',
  'pagos_recibidos_clp',
  'api_requests',
] as const;
export type Metric = (typeof METRICS)[number];

/** La definición que se muestra al pasar el cursor (SPEC §19). */
export const DEFINICIONES: Record<Metric | 'primera_respuesta' | 'sin_responder_ahora' | 'tasa_cierre', string> = {
  conversaciones_nuevas: 'Conversaciones creadas en el rango (primer mensaje del cliente).',
  resueltas: 'Conversaciones marcadas como resueltas en el rango.',
  oportunidades_creadas: 'Oportunidades creadas en el rango, de cualquier pipeline.',
  ganadas: 'Oportunidades cerradas como ganadas en el rango.',
  perdidas: 'Oportunidades cerradas como perdidas en el rango.',
  valor_ganado_clp: 'Suma en pesos de las oportunidades ganadas en el rango (valor congelado al cerrar).',
  ia_ejecuciones: 'Corridas del asistente (sugerir, responder, resumir, transcribir…) en el rango.',
  ia_costo_usd: 'Costo estimado en USD de esas corridas, según el precio por token de cada modelo.',
  mensajes_enviados: 'Mensajes salientes entregados al canal en el rango.',
  costo_meta_usd: 'Costo informado por Meta para los mensajes de WhatsApp del rango (si el canal está activo).',
  citas_agendadas: 'Citas agendadas en el rango. Se llena cuando el módulo de agenda esté activo (Fase 4).',
  citas_asistidas: 'Citas marcadas como asistidas. Se llena cuando el módulo de agenda esté activo (Fase 4).',
  pagos_recibidos_clp: 'Pagos confirmados en pesos. Se llena cuando el módulo de pagos esté activo (Fase 4).',
  api_requests: 'Requests a la API pública hechas con API key en el rango (volcadas cada 5 minutos).',
  primera_respuesta: 'Tiempo entre el primer mensaje del cliente y la primera respuesta humana. Mediana y percentil 90 sobre las conversaciones respondidas en el rango.',
  sin_responder_ahora: 'Conversaciones abiertas cuyo último mensaje es del cliente, en este instante.',
  tasa_cierre: 'Ganadas dividido por cerradas (ganadas + perdidas) en el rango.',
};

/** El owner sentinel del total por tenant. */
export const TOTAL_OWNER = '00000000-0000-0000-0000-000000000000';
