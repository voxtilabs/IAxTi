/**
 * Qué puede hacer el asistente, dicho para el dueño (#1285).
 *
 * `allowedToolsFor()` cruza lo que el dueño configuró con lo que pide el
 * objetivo, y eso funciona desde #315. Lo que no existía era la forma de
 * configurarlo: `allowed_tools` nacía vacío y no había pantalla, así que cada
 * asistente tenía exactamente las herramientas de su único objetivo y nadie
 * podía darle una más.
 *
 * ## Por qué un rótulo aparte y no la descripción que ya hay
 *
 * `ESQUEMAS` tiene una descripción por herramienta, pero está redactada para
 * el MODELO y en segunda persona: «Úsala cuando quede algo pendiente que
 * alguien tiene que hacer». Al dueño hay que decirle «Dejar una nota en la
 * ficha del cliente», que es otra frase y otro destinatario.
 *
 * ## `paraQuien` no es decorativo
 *
 * Es lo que impide que esta pantalla reabra el agujero de la #410. Las
 * herramientas de `analytics` devuelven cifras del negocio, y el copiloto
 * llegó a tomar el asistente de estadísticas para contestarle a un cliente
 * por WhatsApp —con las métricas colgadas—. El filtro `atiendeClientes()`
 * cerró esa puerta por el lado del asistente; sin este campo, la pantalla la
 * volvería a abrir por el lado de la configuración: bastaría marcar una
 * casilla para que un bot de WhatsApp pudiera leer la facturación.
 *
 * Así que la pantalla de un asistente que habla con CLIENTES no ofrece las de
 * `'dueño'`, y al revés.
 */

export interface HerramientaParaElDueno {
  /** Cómo se lee en la pantalla. Imperativo y sin jerga. */
  rotulo: string;
  /**
   * `true` si deja algo escrito en el negocio.
   *
   * La pantalla lo marca porque es la única distinción que al dueño le cambia
   * la decisión: leer de más es un problema de privacidad, escribir de más le
   * ensucia el CRM o le toma una hora que no era.
   */
  escribe: boolean;
  /** Con quién habla un asistente que puede usarla. */
  paraQuien: 'cliente' | 'dueño' | 'ambos';
}

export const CATALOGO_PARA_EL_DUENO: Record<string, HerramientaParaElDueno> = {
  // Lo que puede MIRAR.
  'conversations.get_context': {
    rotulo: 'Mirar lo que ya se habló en la conversación',
    escribe: false,
    paraQuien: 'ambos',
  },
  'knowledge.search': {
    rotulo: 'Buscar en lo que le enseñaste del negocio',
    escribe: false,
    paraQuien: 'ambos',
  },
  'knowledge.get_product': {
    rotulo: 'Consultar un producto del catálogo',
    escribe: false,
    paraQuien: 'ambos',
  },
  'calendar.get_slots': {
    rotulo: 'Ver los horarios libres de la agenda',
    escribe: false,
    paraQuien: 'ambos',
  },
  'crm.find_contact': {
    rotulo: 'Buscar la ficha de un cliente',
    escribe: false,
    paraQuien: 'ambos',
  },
  'crm.get_history': {
    rotulo: 'Ver qué le compró antes y qué se le dijo',
    escribe: false,
    paraQuien: 'ambos',
  },
  // Las cifras del negocio: solo para el asistente del DUEÑO (#410).
  'analytics.metrica': {
    rotulo: 'Consultar una cifra del negocio',
    escribe: false,
    paraQuien: 'dueño',
  },
  'analytics.comparar': {
    rotulo: 'Comparar cifras entre dos períodos',
    escribe: false,
    paraQuien: 'dueño',
  },
  'analytics.catalogo': {
    rotulo: 'Ver qué cifras puede consultar',
    escribe: false,
    paraQuien: 'dueño',
  },
  // Lo que puede ESCRIBIR. Cada una pasó por una ADR.
  'crm.create_activity': {
    rotulo: 'Dejar una nota o una tarea en la ficha',
    escribe: true,
    paraQuien: 'ambos',
  },
  'crm.create_deal': {
    rotulo: 'Abrir una oportunidad de venta',
    escribe: true,
    paraQuien: 'ambos',
  },
  'calendar.book': {
    rotulo: 'Tomar una hora en la agenda',
    escribe: true,
    paraQuien: 'cliente',
  },
  'calendar.reschedule': {
    rotulo: 'Mover la hora que ya tiene el cliente',
    escribe: true,
    paraQuien: 'cliente',
  },
};

/** ¿Esta herramienta se le puede ofrecer a un asistente que habla con `destinatario`? */
export function sirveParaEseAsistente(
  nombre: string,
  destinatario: 'cliente' | 'dueño',
): boolean {
  const d = CATALOGO_PARA_EL_DUENO[nombre];
  // Una herramienta sin rótulo no se ofrece: la guarda de #1285 impide que
  // eso pase en el repo, y acá cerramos por seguridad en vez de mostrar su
  // nombre técnico al dueño.
  if (!d) return false;
  return d.paraQuien === 'ambos' || d.paraQuien === destinatario;
}
