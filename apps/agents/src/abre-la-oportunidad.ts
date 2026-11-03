import type { HerramientaExpuesta } from '@iaxti/module-agents';

/**
 * El embudo no depende de que el modelo se acuerde (#1243).
 *
 * Medido el 3 de noviembre con un visitante real del stand: contacto creado,
 * conversación abierta, respuesta correcta, `intencion: "cotizar"`,
 * `calificacion: "caliente"` — y `tools_called: []`. Cero oportunidades. El
 * prompt le pide al modelo que PROPONGA la acción y que quede «esperando el
 * visto bueno de quien atiende», y en autónomo no hay nadie atendiendo: la
 * propuesta espera a alguien que no va a llegar.
 *
 * Así que la oportunidad no la decide el modelo: la decide la clasificación que
 * el modelo YA devolvió. Eso cambia una lotería por una regla — y una regla se
 * puede probar, que es lo que esto trae.
 *
 * Lo que NO cambia: sigue pasando por `crm.create_deal`, la misma herramienta
 * con el mismo permiso, la misma auditoría y el mismo tope de una escritura por
 * generación. No hay un segundo camino que escriba en el CRM.
 */
const INTENCIONES_DE_COMPRA = new Set(['cotizar', 'comprar']);

/** Una oportunidad se abre por lo que la persona quiere, o por qué tan cerca está. */
export function quiereComprar(clasificacion: {
  intencion: string | null;
  calificacion: string | null;
}): boolean {
  if (clasificacion.intencion && INTENCIONES_DE_COMPRA.has(clasificacion.intencion)) return true;
  return clasificacion.calificacion === 'caliente';
}

export interface DatosDeLaOportunidad {
  /** Para el título: el nombre si lo hay, y si no, el canal. */
  nombreDelContacto: string | null;
  intencion: string | null;
}

/**
 * Abre la oportunidad si corresponde, y nunca a costa de la respuesta.
 *
 * Devuelve el motivo por el que no la abrió —no un booleano— porque los cuatro
 * motivos son distintos y el dueño merece saber cuál fue: «no quería comprar»,
 * «ya la tenía», «no configuraste la identidad» y «la herramienta falló» piden
 * cuatro cosas diferentes de él.
 */
export async function abreLaOportunidad(entrada: {
  tools: HerramientaExpuesta[];
  clasificacion: { intencion: string | null; calificacion: string | null };
  datos: DatosDeLaOportunidad;
  /** Si esta conversación ya tiene una oportunidad abierta. */
  yaTiene: () => Promise<boolean>;
}): Promise<{ creada: boolean; motivo?: string; detalle?: string }> {
  if (!quiereComprar(entrada.clasificacion)) return { creada: false, motivo: 'no_es_de_compra' };

  // La herramienta es la que dice si hay identidad: sin ella no viaja. Mirar
  // `actua_como_user_id` acá sería una segunda fuente de verdad sobre lo mismo.
  const crear = entrada.tools.find((t) => t.name === 'crm.create_deal');
  if (!crear) return { creada: false, motivo: 'sin_identidad' };

  if (await entrada.yaTiene()) return { creada: false, motivo: 'ya_tenia' };

  // Sin monto, sin plazo y sin fecha de cierre: nada que la IA pueda inventar
  // (regla de negocio, SPEC). El título dice de dónde salió, que es lo que
  // quien la mire mañana necesita saber.
  const quien = entrada.datos.nombreDelContacto?.trim();
  const titulo = quien ? `${quien} — escribió al bot` : 'Lead del bot';
  try {
    const r = await crear.ejecutar({ title: titulo });
    return { creada: true, detalle: typeof r === 'string' ? r : JSON.stringify(r) };
  } catch (err) {
    // El cliente ya tiene su respuesta; que el CRM falle no se la puede quitar.
    return { creada: false, motivo: 'falló', detalle: (err as Error).message };
  }
}
