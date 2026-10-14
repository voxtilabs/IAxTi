/**
 * Qué ofrecerle a alguien que abre el Agente General y no sabe qué pedirle (#584).
 *
 * ## El defecto que esto viene a sacar
 *
 * Las sugerencias vivían en `apps/web/lib/donde-estoy.ts`, como listas fijas
 * por pantalla. Y el issue lo había advertido antes de que existieran:
 *
 *   «Tres pastillas escritas a mano serían otra cosa declarada en un lado: si
 *    mañana el módulo de pagos está apagado para ese negocio, "crea un link de
 *    cobro" no funciona, y una sugerencia que falla al tocarla es peor que
 *    ninguna.»
 *
 * Medido el 12-10: `USER_PERMS` tiene `agents.use` —usar el copiloto— y **no**
 * tiene `automations.manage`. Así que un vendedor parado en la bandeja veía
 * «Deriva a una persona cuando el cliente se enoja», la tocaba, y el agente le
 * contestaba que no puede: sus 195 herramientas se filtran por permiso antes
 * de ofrecérselas al modelo.
 *
 * Una sugerencia que el producto ofrece y después no puede cumplir.
 *
 * ## Por qué cada una nombra una HERRAMIENTA y no un permiso
 *
 * Anotar el permiso a mano sería el mismo defecto una vuelta más arriba: dos
 * listas que tienen que coincidir, y el día que una herramienta cambie de
 * permiso la sugerencia sigue diciendo el viejo.
 *
 * Nombrando la herramienta, el permiso y el módulo salen del catálogo, que se
 * GENERA del código. Si mañana `automations.create` pide otro permiso, esto lo
 * sigue sin que nadie se acuerde.
 *
 * Es el mismo patrón que `comoSeArregla` en `queLeFalta`, que nombra una
 * herramienta del catálogo y se anula si el actor no la tiene.
 *
 * ## Y el texto sí lo escribe una persona
 *
 * Porque ninguna máquina escribe «Avísame si una cotización lleva 2 días
 * parada» a partir de `automations.create`. La frase es curada; la
 * ELEGIBILIDAD es derivada. Igual que `catalogo-curado.ts`.
 */

export interface Sugerencia {
  /** Desde qué pantalla se ofrece. `null` = desde cualquiera. */
  pantalla: string | null;
  /** La frase, en primera persona del negocio y español de Chile. */
  texto: string;
  /**
   * La herramienta que lo resolvería, por su nombre del catálogo.
   *
   * De acá salen el permiso y el módulo. Si el actor no la tiene, la
   * sugerencia no se ofrece — no hay sugerencia que falle al tocarla.
   */
  herramienta: string;
}

/**
 * Las sugerencias, por pantalla.
 *
 * Varias se repiten en pantallas distintas a propósito: «avísame si una
 * cotización lleva 2 días parada» es lo que alguien quiere tanto en
 * oportunidades como en inicio, y repetirla es más útil que mandarlo a
 * buscarla.
 */
export const SUGERENCIAS: Sugerencia[] = [
  // Bandeja
  { pantalla: 'bandeja', texto: 'Contéstale a los que llevan más de un día esperando', herramienta: 'conversations.reply' },
  { pantalla: 'bandeja', texto: 'Deriva a una persona cuando el cliente se enoja', herramienta: 'automations.create' },
  { pantalla: 'bandeja', texto: 'Arma una respuesta rápida para el precio del despacho', herramienta: 'plantillas.create' },
  // Oportunidades
  { pantalla: 'oportunidades', texto: 'Avísame si una cotización lleva 2 días parada', herramienta: 'automations.create' },
  { pantalla: 'oportunidades', texto: 'Agrega una etapa de "esperando pago" antes del cierre', herramienta: 'deals.pipelines' },
  { pantalla: 'oportunidades', texto: '¿En qué etapa se me caen más los negocios?', herramienta: 'analytics.dashboard' },
  // Contactos
  { pantalla: 'contactos', texto: 'Etiqueta como "mayorista" a los que compran más de 5 unidades', herramienta: 'tags.create' },
  { pantalla: 'contactos', texto: 'Sácame la cartera en un Excel', herramienta: 'contacts.exportarXlsx' },
  { pantalla: 'contactos', texto: '¿A cuántos contactos nuevos llegué este mes?', herramienta: 'analytics.dashboard' },
  // Agenda
  { pantalla: 'agenda', texto: 'Quiero atender los sábados en la mañana', herramienta: 'agenda.disponibilidad' },
  { pantalla: 'agenda', texto: 'Recuérdale la hora al cliente el día antes', herramienta: 'agenda.guardarRecordatorios' },
  { pantalla: 'agenda', texto: 'Deja 15 minutos entre una hora y la siguiente', herramienta: 'agenda.disponibilidad' },
  // Campañas
  { pantalla: 'campanas', texto: 'Mándale la promoción a los que compraron hace más de 3 meses', herramienta: 'campanas.crear' },
  { pantalla: 'campanas', texto: '¿A cuánta gente le llegaría ese segmento?', herramienta: 'automations.preview' },
  { pantalla: 'campanas', texto: 'Arma una plantilla para avisar que llegó el pedido', herramienta: 'plantillas.create' },
  // Reportes
  { pantalla: 'reportes', texto: '¿Cuánto gasté en IA este mes?', herramienta: 'agents.usage' },
  { pantalla: 'reportes', texto: '¿Cuánto se demora mi equipo en contestar?', herramienta: 'analytics.dashboard' },
  { pantalla: 'reportes', texto: '¿Cuánto vendí este mes contra el pasado?', herramienta: 'analytics.dashboard' },
  // Pendientes
  { pantalla: 'pendientes', texto: '¿Qué tengo que hacer hoy?', herramienta: 'contacts.actividades' },
  { pantalla: 'pendientes', texto: 'Recuérdame llamar a los que cotizaron y no respondieron', herramienta: 'automations.create' },
  // Conocimiento
  { pantalla: 'conocimiento', texto: 'Aquí va mi lista de precios', herramienta: 'knowledge.add' },
  { pantalla: 'conocimiento', texto: '¿Qué le falta saber al asistente para contestar bien?', herramienta: 'knowledge.products' },
  { pantalla: 'conocimiento', texto: 'Mis horarios de atención son de 10 a 19', herramienta: 'knowledge.add' },
  // Asistente
  { pantalla: 'asistente', texto: 'Quiero un segundo asistente solo para postventa', herramienta: 'agents.create' },
  { pantalla: 'asistente', texto: 'Que sea más breve y trate de usted', herramienta: 'agents.update' },
  { pantalla: 'asistente', texto: '¿Cómo le está yendo a mi asistente?', herramienta: 'agents.executions' },
  // Automatizaciones
  { pantalla: 'automatizaciones', texto: 'Avísame si una cotización lleva 2 días parada', herramienta: 'automations.create' },
  { pantalla: 'automatizaciones', texto: 'Cuando alguien pregunte por precios, mándale la lista', herramienta: 'automations.create' },
  { pantalla: 'automatizaciones', texto: 'Etiqueta solo a los que preguntan por arriendo', herramienta: 'automations.create' },
  // Canales
  { pantalla: 'canales', texto: 'Quiero conectar mi WhatsApp', herramienta: 'channels.resume' },
  { pantalla: 'canales', texto: 'Pon el chat en mi sitio web', herramienta: 'webchatAdmin.create' },
  { pantalla: 'canales', texto: '¿Por qué no me llegan los mensajes?', herramienta: 'channels.diagnostico' },
  // Plantillas
  { pantalla: 'plantillas', texto: 'Arma una plantilla para avisar que llegó el pedido', herramienta: 'plantillas.create' },
  { pantalla: 'plantillas', texto: 'Mándale la plantilla de seguimiento a quien cotizó ayer', herramienta: 'plantillas.enviar' },
  // Embudos
  { pantalla: 'embudos', texto: 'Arma un embudo para arriendos', herramienta: 'deals.pipelines' },
  { pantalla: 'embudos', texto: 'Agrega una etapa de "esperando pago" antes del cierre', herramienta: 'deals.pipelines' },
  // Equipo
  { pantalla: 'equipo', texto: 'Invita a alguien que solo atienda conversaciones', herramienta: 'equipoUsuarios.invitar' },
  { pantalla: 'equipo', texto: 'Quiero que María pueda ver los reportes', herramienta: 'equipoUsuarios.equipo' },
  // Cobros
  { pantalla: 'cobros', texto: 'Quiero cobrar por el chat', herramienta: 'payments.providers' },
  { pantalla: 'cobros', texto: 'Mándale un link de pago a quien cerró ayer', herramienta: 'payments.createLink' },
  // Facturación
  { pantalla: 'facturacion', texto: '¿Qué incluye mi plan?', herramienta: 'billing.billing' },
  { pantalla: 'facturacion', texto: '¿Cuánto gasté en IA este mes?', herramienta: 'agents.usage' },
  // Empresas
  { pantalla: 'empresas', texto: 'Junta a estos contactos bajo la misma empresa', herramienta: 'contactoEmpresa.asignar' },
  { pantalla: 'empresas', texto: '¿Cuánto me compró esta empresa en total?', herramienta: 'analytics.dashboard' },
  // Ajustes
  { pantalla: 'ajustes', texto: '¿Qué me falta configurar?', herramienta: 'agents.diagnostico' },
  { pantalla: 'ajustes', texto: 'Quiero atender los sábados en la mañana', herramienta: 'agenda.disponibilidad' },
  { pantalla: 'ajustes', texto: 'Avísame si una cotización lleva 2 días parada', herramienta: 'automations.create' },
  // Inicio
  { pantalla: 'inicio', texto: '¿Qué me falta para empezar a vender?', herramienta: 'agents.diagnostico' },
  { pantalla: 'inicio', texto: 'Avísame si una cotización lleva 2 días parada', herramienta: 'automations.create' },
  { pantalla: 'inicio', texto: 'Quiero atender los sábados en la mañana', herramienta: 'agenda.disponibilidad' },
  { pantalla: 'inicio', texto: '¿Cuánto gasté en IA este mes?', herramienta: 'agents.usage' },
];

/**
 * El último recurso, para cuando el actor no puede NINGUNA de las de su
 * pantalla.
 *
 * `agents.diagnostico` pide `tenant.read`, que lo tiene hasta el rol más
 * básico, así que esta sugerencia nunca queda afuera. Y es la correcta para
 * ese caso: si no podés hacer casi nada, lo primero es ver qué falta.
 */
export const SUGERENCIA_DE_ULTIMO_RECURSO: Sugerencia = {
  pantalla: null,
  texto: '¿Qué me falta configurar?',
  herramienta: 'agents.diagnostico',
};
