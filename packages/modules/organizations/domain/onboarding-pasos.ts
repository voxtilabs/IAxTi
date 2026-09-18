// El catálogo de pasos del onboarding (SPEC §7): qué es cada uno y qué hay
// que hacer, en la voz de Pulso — qué pasó y qué hacer, sin jerga. Puro: el
// texto no depende de la base ni de qué módulos estén activos.

import type { OnboardingState } from './state';

export interface DefinicionDePaso {
  id: OnboardingState;
  titulo: string;
  /** Qué hay que hacer. Una frase, tuteo, español de Chile. */
  ayuda: string;
  /** El módulo que resuelve el paso. Si está apagado, el paso no aplica. */
  modulo: string | null;
  /**
   * Un paso opcional no impide terminar. El negocio que no tiene equipo ni
   * catálogo igual puede vender: obligarlo a inventarse un paso para sacarse
   * el cartel de "te falta algo" es hacerle perder el tiempo.
   */
  opcional: boolean;
}

export const PASOS: readonly DefinicionDePaso[] = [
  {
    id: 'registered',
    titulo: 'Crea tu cuenta',
    ayuda: 'Listo: ya tienes cuenta.',
    modulo: null,
    opcional: false,
  },
  {
    id: 'configured',
    titulo: 'Cuéntanos de tu negocio',
    ayuda: 'Describe a qué te dedicas y te armamos el embudo, las respuestas rápidas y las plantillas.',
    modulo: 'crm',
    opcional: false,
  },
  {
    id: 'whatsapp_connected',
    titulo: 'Conecta tu WhatsApp',
    ayuda: 'Conecta el número con el que ya te escriben tus clientes.',
    modulo: 'whatsapp',
    opcional: false,
  },
  {
    id: 'knowledge_added',
    titulo: 'Sube lo que vendes',
    ayuda: 'Tu catálogo o tus precios, para que el asistente no invente nada.',
    modulo: 'knowledge',
    opcional: true,
  },
  {
    id: 'team_invited',
    titulo: 'Invita a tu equipo',
    ayuda: 'Si atienden entre varios, invítalos y repártanse las conversaciones.',
    modulo: 'identity',
    opcional: true,
  },
  {
    id: 'first_message',
    titulo: 'Recibe tu primer mensaje',
    ayuda: 'Escríbete desde otro teléfono para ver cómo se ve la bandeja.',
    modulo: 'conversations',
    opcional: false,
  },
];

/** Los que faltan para poder decir que el onboarding terminó. */
export const PASOS_OBLIGATORIOS = PASOS.filter((p) => !p.opcional).map((p) => p.id);
