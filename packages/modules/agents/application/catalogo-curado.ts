/**
 * Lo único del catálogo que escribe una persona (#492, ADR-0025).
 *
 * El inventario —ruta, verbo, permiso, módulo y la forma de los
 * argumentos— se GENERA del código (`catalogo.generated.ts`). Acá va lo que
 * ninguna máquina puede inferir:
 *
 *  1. **Qué NO debe ser herramienta jamás**, con su motivo.
 *  2. **Qué escrituras no necesitan confirmación** porque se deshacen.
 *  3. **Descripciones** mejores que el resumen del endpoint, cuando el
 *     resumen no le alcanza al modelo para llamarla bien.
 */

/**
 * Las que el Agente General NO puede llamar nunca.
 *
 * No es una lista de "todavía no": es una lista de "no tiene sentido" y de
 * "sería un arma". Un webhook expuesto como herramienta dejaría al agente
 * FABRICAR mensajes entrantes de clientes que nunca escribieron, y eso no
 * es una función que falte: es una puerta que no debe existir.
 */
export const NO_SON_HERRAMIENTA: Record<string, string> = {
  GoogleCalendarController_estado: 'Estado de la conexión OAuth personal para su pantalla; el agente usa agenda.huecos, no credenciales (#57).',
  GoogleCalendarController_iniciar: 'Consentimiento del navegador con state, nonce y PKCE; solo lo inicia la persona (#57).',
  GoogleCalendarController_completar: 'Canje de código OAuth y verifier de una pestaña; nunca son argumentos de una herramienta de IA (#57).',
  GoogleCalendarController_revocar: 'Revocación global de permisos Google de la persona; se confirma en su pantalla, no por el agente (#57).',
  GoogleCalendarWebhookController_recibir: 'Notificación autenticada de Google; no permite fabricar cambios desde la IA (#57).',

  // Infraestructura: las llama Docker, el smoke del despliegue y Uptime Kuma.
  HealthController_health: 'Liveness de la infraestructura; no es una función del negocio (#17).',
  HealthController_ready: 'Readiness del despliegue; no es una función del negocio (#17).',
  HealthController_modules: 'Diagnóstico de arranque para quien opera, no para el agente (#11).',

  // Las llama alguien de AFUERA, con su firma. Exponerlas sería dejar que
  // el agente se escriba a sí mismo.
  WebhooksController_recibir:
    'Webhook de canales: el agente podría FABRICAR mensajes entrantes de clientes que nunca escribieron (#41).',
  PaymentWebhooksController_recibir:
    'Webhook de pagos: el agente podría dar por pagado un cobro que nadie pagó (#61).',
  WebchatController_config: 'La llama el widget del sitio del cliente, no una persona (#46).',

  // Subir un archivo es de las manos de una persona, no de un agente (#522).
  // El tope de cobro del vendedor: es un ajuste de gobierno, no una acción del
  // día (#535). Leerlo no molesta a nadie, pero la ESCRITURA es justo el límite
  // que protege al negocio de un cobro de más, y no puede moverla algo que
  // conversa. La cambia una persona con `tenant.settings`, en su pantalla.
  PaymentsController_guardarAjustes:
    'Sube o baja el tope de monto de quien cobra: es el límite que protege al negocio, y lo mueve una persona en su pantalla (#535).',

  PlatformController_ampliacionDeIa:
    'Fija un cargo mensual en la factura de un cliente. Es la misma línea que PaymentsController_guardarAjustes: lo que toca plata lo mueve una persona en su pantalla, no algo que conversa (#536).',

  EquipoController_limitesDeAdjunto:
    'Le dice a la interfaz qué tipos y qué tamaños acepta el canal, para poner el `accept` del selector. Es cableado de pantalla, no una pregunta que alguien le haga a un asistente (#560).',

  KnowledgeController_destinoDelPdf:
    'Devuelve dónde poner un archivo que el agente no tiene: no puede elegir un PDF del computador de nadie (#522).',
  KnowledgeController_crearDesdePdf:
    'Registra un PDF YA subido; sin el paso de subir, el agente solo podría apuntar a archivos que no puso él (#522).',
  WebchatController_session: 'Ídem: abre la sesión del visitante anónimo (#46).',
  WebchatController_message: 'Ídem: entra un mensaje del visitante; fabricarlo sería lo mismo que el webhook (#46).',
  WebchatController_replies: 'Ídem: el sondeo del widget (#46).',

  /**
   * Probar la IA (#869). Y el motivo no es el costo, aunque cueste.
   *
   * Es que la herramienta sería inútil EXACTAMENTE en el caso en que haría
   * falta: para que el agente la llame, el agente tiene que estar contestando
   * —o sea, la IA ya funciona—; y si no contesta, no puede llamar nada. Una
   * herramienta que solo se puede usar cuando no se necesita.
   *
   * Lo que sí hace falta es el botón, que lo aprieta una persona y no depende
   * de que el modelo esté vivo. Por eso esto vive en una pantalla.
   */
  /**
   * Las sugerencias de arranque (#584). Y el motivo no es el costo: es que
   * sería una segunda forma de hacer una cosa.
   *
   * Esto le dice a una PANTALLA qué ofrecerle a quien no sabe qué pedir. El
   * agente ya sabe qué puede hacer —`buscar_herramienta` recorre sus 195 y le
   * dice cuáles tiene— así que preguntárselo por acá sería pedirle que se
   * consulte a sí mismo por otra puerta, y con una lista de frases curadas que
   * no cubre ni la décima parte de lo que puede.
   */
  AgenteGeneralController_sugerencias:
    'Le dice a la pantalla qué ofrecerle a quien no sabe qué pedir. El agente ya sabe qué puede hacer con buscar_herramienta: esto sería una segunda forma de hacer una cosa, y más pobre (#584).',

  AgentsController_probar:
    'Le hace una llamada real al proveedor para ver si contesta. Para que el agente la llame tendría que estar contestando ya, así que es inútil justo cuando haría falta: la aprieta una persona en su pantalla (#869).',
  PlatformController_probarLosProveedores:
    'Ídem, y además es de plataforma: prueba las cuatro llaves de IAxTi, no algo de un negocio. Quien puede cargar crédito lo mira en el SuperAdmin (#869).',

  // Simulador de entrada: existe para probar, y en producción ni se registra.
  SimuladorController_inbound:
    'Simula un mensaje entrante. Es la misma puerta que el webhook: fabricar clientes no es una función (#36).',
  DemoController_noExiste: 'Fixture del formato de error; no hace nada (#11).',
  DemoController_protegido: 'Fixture del guard de permisos; no hace nada (#9).',

  // Recursión: el agente llamándose a sí mismo.
  McpController_rpc: 'Es la puerta de ENTRADA de una IA de afuera; el agente usándola se llama a sí mismo (#419).',
  AgentsController_run: 'Correr un agente desde un agente es recursión sin tope (#49).',
  AgentsController_preguntar: 'Ídem: es la conversación con el asistente, no una herramienta suya.',
  AgenteGeneralController_conversar:
    'Es la puerta por la que el Agente General habla: dársela como herramienta es él llamándose a sí mismo (#493).',
  AgenteGeneralController_aplicar:
    'Aplicar una propuesta es el acto de la PERSONA que aprueba; el agente haciéndolo se saltaría su propio visto bueno (#493).',
  PlatformController_agenteGeneral:
    'El tablero de la plataforma sobre él mismo: mirarse en el espejo no es una función del negocio (#496).',
  PlatformController_apagarAgente:
    'Su propio interruptor: un agente que puede apagarse —o volver a encenderse— no tiene interruptor (#496).',
  PlatformController_encenderAgente:
    'Ídem: encenderse solo después de que alguien lo apagó es exactamente lo que el interruptor viene a evitar (#496).',

  // Las que solo piden SESIÓN, sin tenant ni permiso: son del acto de
  // entrar, no del negocio. Sin permiso no hay cómo filtrarlas por quien
  // habla, así que ninguna puede ser herramienta.
  MeController_modules:
    'Arma el menú de la aplicación; el agente no dibuja menús (#11). Obsoleta desde #629: contesta lo mismo que ModulesController_catalogo, que la reemplaza.',
  ModulesController_catalogo:
    'El catálogo de módulos del DESPLIEGUE, para dibujar el menú; el agente no dibuja menús (#629). Pública y sin permiso: devuelve lo mismo para todos y no hay nada del negocio que filtrar.',
  MeController_me: 'Dice quién es el usuario de la sesión; el agente ya actúa a nombre de alguien (#7).',
  OnboardingRegistrationController_register:
    'El alta inicial pertenece a la persona autenticada antes de elegir negocio; el agente ya actúa dentro de uno y no puede crearle otro ni asignarse ADMIN (#56).',
  InvitacionesController_aceptar:
    'Aceptar una invitación es un acto PERSONAL de quien la recibió, con su token; hacerlo por él no (#7).',
};

/**
 * Escrituras que NO piden confirmación.
 *
 * El criterio es el de la ADR-0017, ahora escrito como dato: **¿lo ve el
 * cliente y se puede deshacer?** Lo que queda adentro del negocio y tiene
 * un estado que lo anula —una nota, una tarea, un borrador— entra acá. Lo
 * que sale hacia una persona de afuera o borra, no entra nunca.
 *
 * Todo lo que no esté acá y no sea GET se le muestra al dueño como diff
 * antes de aplicarse. Es el default seguro: una herramienta nueva nace
 * pidiendo permiso.
 */
export const SIN_CONFIRMACION = new Set<string>([
  // Quedan adentro del negocio y se deshacen: una actividad se cancela, una
  // oportunidad se marca perdida, un atajo se borra.
  'ContactsController_crear', // una actividad en la ficha (POST /contacts/:id/activities)
  'ContactsController_listo', // marcar hecha esa actividad
  'EquipoController_addNote', // nota INTERNA en la conversación: el cliente no la ve
  'DealsController_create',
  'QuickRepliesController_create',
  'TagsController_create',
  'TagsController_marcar', // etiquetar a alguien: se desmarca igual de fácil
  // Nacen APAGADAS: el interruptor es otra llamada, y esa sí confirma.
  'AutomationsController_create',
  'AutomationsController_createSeq',
  'PlantillasController_create',
  // Vistas previas y conteos: no escriben nada pese a ser POST.
  'CampanasController_vistaPrevia',
  'ContactsController_importPreview',
  'AgentsController_configuradorProponer',
]);

/**
 * Cuando el resumen del endpoint no le alcanza al modelo.
 *
 * El resumen de Swagger está escrito para una persona que lee la
 * documentación; la descripción de una herramienta está escrita para un
 * modelo que decide CUÁNDO usarla. Casi siempre el resumen sirve —por eso
 * esta lista es corta a propósito—, pero donde decidir mal cuesta caro
 * conviene decírselo con todas las letras.
 */
export const DESCRIPCIONES: Record<string, string> = {
  ContactsController_list:
    'Busca contactos del negocio por nombre, teléfono o RUT. Úsala ANTES de crear uno: si la persona ya está, crear otro duplica su historia.',
  PlantillasController_enviar:
    'Manda una plantilla aprobada a una conversación. Es lo ÚNICO que sale cuando pasaron más de 24 h desde el último mensaje del cliente; dentro de la ventana, responde normal.',
  AgendaController_huecos:
    'Las horas libres de un día. Pídelas siempre antes de ofrecer una hora: acá ya está descontado lo agendado, el respiro entre citas y la anticipación mínima.',
  BillingController_cancelar:
    'CANCELA la suscripción del negocio y entrega su exportación completa. Es irreversible desde la conversación: no la uses para responder dudas sobre el plan.',
  ContactsController_suprimirTitular:
    'Ejerce el derecho de supresión de la Ley 21.719: anonimiza al titular y borra su contenido. No es "borrar un contacto que sobra" — pide siempre el motivo.',
};
