import { TZ_POR_DEFECTO } from '@iaxti/core';
import type { AvisoId } from '../application/recordatorios';

/**
 * Con qué plantilla sale cada recordatorio (#59).
 *
 * Por configuración y NO por convención de nombre. Un `recordatorio_cita`
 * buscado por nombre se rompe el día que alguien renombra la plantilla o
 * crea una segunda para otro idioma, y se rompe en silencio: el barrido no
 * encuentra nada y nadie recibe su aviso.
 *
 * Las dos son opcionales y por separado. Muchos negocios quieren solo el de
 * 2 h —el de 24 h les parece molesto— y tener que apagar el módulo entero
 * para eso sería absurdo.
 */
export interface ConfiguracionDeAvisos {
  /** templateId por aviso. `null` = ese aviso no se manda. */
  plantillas: Record<AvisoId, string | null>;
  /** La zona en que se le dice la hora al cliente. */
  zona: string;
  /** ¿Hay algo configurado? Si no, el barrido no toca ninguna cita. */
  activo: boolean;
}

export function configuracionDeAvisos(
  settings: Record<string, unknown> | null | undefined,
): ConfiguracionDeAvisos {
  const crudo = (settings?.calendar ?? {}) as Partial<{
    recordatorios: Partial<Record<AvisoId, unknown>>;
    zona: unknown;
  }>;
  const plantillas = {
    '24h': idDePlantilla(crudo.recordatorios?.['24h']),
    '2h': idDePlantilla(crudo.recordatorios?.['2h']),
  } as Record<AvisoId, string | null>;
  const zona = typeof crudo.zona === 'string' && crudo.zona.trim() ? crudo.zona : TZ_POR_DEFECTO;
  return {
    plantillas,
    zona,
    activo: Object.values(plantillas).some((p) => p !== null),
  };
}

function idDePlantilla(valor: unknown): string | null {
  return typeof valor === 'string' && valor.trim() ? valor.trim() : null;
}

/**
 * Cómo se le dice la hora a quien recibe el recordatorio.
 *
 * En la zona del NEGOCIO, no en UTC: "tu hora del martes 23 a las 15:30" es
 * lo único que sirve. Una cita dicha en UTC llega tres horas corrida y el
 * cliente se presenta cuando no es.
 */
export function cuandoEnPalabras(cuando: Date, zona = TZ_POR_DEFECTO): string {
  const f = new Intl.DateTimeFormat('es-CL', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: zona,
  });
  // es-CL mete "de" y comas; el resultado directo se lee bien en un chat:
  // "martes, 23 de septiembre, 15:30".
  return f.format(cuando);
}

/**
 * Los valores que se le pasan a la plantilla, en orden.
 *
 * Es un contrato con quien la escribe: `{{1}}` es el nombre y `{{2}}` es
 * cuándo. Va documentado en la pantalla donde se elige la plantilla, porque
 * una plantilla aprobada por Meta no se puede corregir después — se crea
 * otra y se espera la aprobación de nuevo.
 */
export function valoresDelAviso(input: {
  nombre: string | null;
  cuando: Date;
  zona?: string;
  variables: number;
}): string[] {
  const todos = [input.nombre?.trim() || 'Hola', cuandoEnPalabras(input.cuando, input.zona)];
  return todos.slice(0, Math.max(0, input.variables));
}
