import type { Pool, PoolClient } from 'pg';
import type { ModuleRegistry } from '@iaxti/core';
import { degradarSinRomper, withTenant } from '@iaxti/db';
import { diaEn } from '@iaxti/core';
import { zonaDelTenant } from '@iaxti/module-organizations';
import {
  PROVIDERS,
  activeAgent,
  allowedToolsFor,
  effectiveMode,
  marcarLogradoPorElAgente,
  autoRespondForInbound,
  herramientasExpuestas,
  providerAvailable,
  suggestForInbound,
  transcribeInboundAudio,
  guardrailLimits,
} from '@iaxti/module-agents';
import type { HerramientaExpuesta } from '@iaxti/module-agents';
import { abreLaOportunidad } from './abre-la-oportunidad';
import {
  getContext,
  getConversation,
  sendMessage,
  salePorProveedor,
  updateDeliveryStatus,
} from '@iaxti/module-conversations';
import {
  embeddingsAvailable,
  getProduct,
  knowledgeContext,
  fuentesCitadas,
  searchKnowledge,
} from '@iaxti/module-knowledge';
import { agendar, huecosConGoogle, listarCitas } from '@iaxti/module-calendar';
import {
  createActivity,
  createDeal,
  listActivitiesByContact,
  getContactFicha,
  listContacts,
  listCustomFields,
  listDeals,
  listPipelines,
  paraLaIa,
} from '@iaxti/module-crm';
import { roleOf } from '@iaxti/module-identity';
import {
  baseRoleHasPermission,
  customRolePermissions,
  isBaseRole,
} from '@iaxti/module-authorization';
import { presignUrl, storageFromEnv } from '@iaxti/core';

/**
 * Los campos propios del negocio que el asistente SÍ puede ver (#528).
 *
 * Vive en una función con nombre y no suelto dentro del contexto por una razón
 * concreta: el filtro por `visible_ia` es la única cosa que impide que una nota
 * interna salga del negocio, y un filtro que hay que acordarse de aplicar en
 * cada lugar donde se arma un contexto es un filtro que algún día no se aplica.
 *
 * Faltaba entero, y faltaba en los DOS sentidos. El «sí» no servía: una pyme
 * declaraba «Talla», «Modelo del auto» o «Convenio» como visible para el
 * asistente y el asistente jamás lo recibía, así que le volvía a preguntar al
 * cliente lo que la ficha ya tenía — el problema que #440 dice haber resuelto.
 * Y el «no» se cumplía por ACCIDENTE: no había filtro porque no se mandaba
 * nada, así que el día que alguien enchufara `custom` sin acordarse de
 * `paraLaIa`, salían las notas internas. Y los campos que una pyme marca
 * ocultos son justo esos.
 *
 * Devuelve `{}` cuando no hay nada que mostrar, y quien la use no agrega la
 * llave: una llave vacía es una línea más que el modelo lee y el negocio paga.
 */
export async function datosDelNegocioParaLaIa(
  client: PoolClient,
  tenantId: string,
  contactId: string,
): Promise<Record<string, unknown>> {
  /**
   * En SERIE y con SAVEPOINT, por dos razones distintas.
   *
   * El `Promise.all` que había acá era de mentira: un cliente de pg atiende una
   * consulta a la vez, así que las encolaba igual. Y los dos `.catch` no
   * degradaban nada —usan el `client` de quien llama, y en Postgres la
   * sentencia que falla aborta el bloque entero—, así que un campo que no se
   * pudo leer se llevaba puesto todo lo que viniera después (#966).
   *
   * Lo segundo es por qué no quedó un `Promise.all` con `degradarSinRomper`
   * adentro: los savepoints son una PILA, así que si una falla se lleva el
   * trabajo de la otra. Desde #991 el helper se niega en voz alta en vez de
   * dejar pasar eso; igual la forma correcta es la de acá, en serie, que es lo
   * que un cliente de pg hace de todos modos —atiende una consulta a la vez—.
   */
  const campos = await degradarSinRomper(
    client,
    (c) => listCustomFields(c, tenantId, 'contact'),
    (error) => {
      console.warn(
        `copilot: no se pudieron leer los campos personalizados de ${tenantId}; el asistente ` +
          `trabaja sin ellos. Causa: ${error.message}`,
      );
      return [];
    },
  );
  const ficha = await degradarSinRomper(
    client,
    (c) => getContactFicha(c, tenantId, contactId),
    (error) => {
      console.warn(
        `copilot: no se pudo leer la ficha de ${contactId} en ${tenantId}; el asistente trabaja ` +
          `sin ella. Causa: ${error.message}`,
      );
      return null;
    },
  );
  return paraLaIa(campos, (ficha?.contact?.custom as Record<string, unknown>) ?? {});
}

// El copiloto (#48) corre en la cola `agents`, DESPUÉS del camino de
// entrada: la bandeja jamás espera a la IA. Sin llaves de proveedor, el
// job se salta en silencio (staging sin keys no acumula fallos).

export interface SuggestJob {
  moduleId?: 'agents';
  tenantId: string;
  conversationId: string;
  messageId: string;
  audioKey?: string;
  audioType?: string;
  /** El módulo knowledge está activo (#51): el worker consulta el RAG. */
  knowledgeActivo?: boolean;
  requestId?: string;
}

export async function processSuggest(
  pool: Pool,
  data: SuggestJob,
  colas: { registry?: ModuleRegistry } = {},
): Promise<{
  suggestionId?: string;
  autoReplied?: string;
  escalated?: string;
  /** El id del aviso de cortesía que recibió el cliente al escalar (#1019). */
  avisado?: string;
  skipped?: string;
  transcribed?: boolean;
}> {
  if (!PROVIDERS.some((p) => providerAvailable(p))) {
    return { skipped: 'sin llaves de proveedor de IA en este ambiente' };
  }
  return withTenant(pool, data.tenantId, async (client) => {
    /**
     * El último entrante gana (#1223).
     *
     * El job se encola con un respiro de unos segundos para que la persona
     * termine de escribir. Si en ese rato llegó otro mensaje, ESTE job se
     * salta: el del mensaje nuevo va a contestar, y va a contestar con los
     * dos a la vista porque el contexto se lee al ejecutar.
     *
     * Medido antes de esto: «Hola» y «Sigo vivo» en el mismo minuto recibieron
     * dos respuestas completas, con firma las dos. Nadie escribe un mensaje
     * por idea, así que esto no es un caso raro: es el caso normal.
     *
     * Se compara por `seq`, que es el orden propio de la conversación y el
     * mismo con el que se arma el contexto. `created_at` también serviría
     * —`timestamptz` tiene microsegundos—, así que esto no es una corrección
     * de un defecto: es usar el orden que la conversación ya define en vez de
     * uno paralelo. La prueba no distingue los dos, y está bien que no lo
     * haga: no hay defecto que atajar ahí.
     */
    const masNuevo = await client.query(
      `SELECT 1 FROM messages m
        WHERE m.tenant_id = $1 AND m.conversation_id = $2 AND m.direction = 'in'
          AND m.seq > (SELECT seq FROM messages WHERE tenant_id = $1 AND id = $3)
        LIMIT 1`,
      [data.tenantId, data.conversationId, data.messageId],
    );
    if (masNuevo.rowCount) {
      return { skipped: 'llegó otro mensaje después: contesta el job de ese' };
    }
    let transcribed = false;
    // El audio primero (#48): transcrito, entra solo al contexto.
    if (data.audioKey && providerAvailable('google')) {
      const storage = storageFromEnv();
      if (storage) {
        try {
          const res = await fetch(presignUrl(storage, 'GET', data.audioKey));
          if (res.ok) {
            const texto = await transcribeInboundAudio(client, {
              tenantId: data.tenantId,
              messageId: data.messageId,
              bytes: new Uint8Array(await res.arrayBuffer()),
              contentType: data.audioType ?? 'audio/ogg',
              requestId: data.requestId,
            });
            transcribed = texto !== null;
          }
        } catch {
          /* audio sin transcribir no frena la sugerencia */
        }
      }
    }
    // El conocimiento del negocio (#51): retrieval con citas ANTES de
    // generar — la IA responde con lo que el negocio dice, no lo que
    // imagina. Sin módulo o sin llaves, sigue sin conocimiento (y el
    // modo autónomo escala más, por diseño del prompt).
    /**
     * El agente del negocio, una sola vez (#1239).
     *
     * Hace falta ANTES del bloque de conocimiento para saber si esta
     * conversación va a contestarse sola: de eso depende si se le pide al
     * modelo que cite la fuente o no. `activeAgent` cachea por tenant, así
     * que pedirlo acá no agrega una consulta por mensaje.
     */
    const agenteDelTenant = await activeAgent(client, data.tenantId);
    let knowledge: string | null = null;
    // Y en QUÉ fuentes se apoyó ese bloque (#714): el acta de la corrida. Se
    // arma acá, donde el retrieval acaba de pasar, porque `knowledgeContext`
    // devuelve texto y del texto no se puede sacar el id de la fuente.
    let fuentes: Array<{ id: string; nombre: string }> | undefined;
    if (data.knowledgeActivo && embeddingsAvailable()) {
      try {
        /**
         * Con qué texto se consulta el conocimiento (#1212).
         *
         * El de ESTE mensaje, y si no trae —una foto sin pie, un documento,
         * un audio que no se pudo transcribir—, lo último que dijo el cliente
         * en esta conversación.
         *
         * Antes esto era solo el primero, así que una foto sin pie llegaba al
         * modelo sin el conocimiento del negocio: el acta de las 20:13:56 lo
         * dice con sus palabras, «no tengo el catálogo a mano», con cinco
         * fuentes activas sin usar.
         *
         * El respaldo NO es inventarle una pregunta: es el mismo contexto con
         * el que el agente contesta todo lo demás. Y si la conversación
         * arranca con una foto y el cliente nunca escribió nada, no hay con
         * qué buscar y no se busca.
         */
        const entrante = await client.query(
          `SELECT COALESCE(
                    (SELECT COALESCE(body, transcription) FROM messages
                      WHERE tenant_id = $1 AND id = $2),
                    (SELECT COALESCE(body, transcription) FROM messages
                      WHERE tenant_id = $1 AND conversation_id = $3 AND direction = 'in'
                        AND COALESCE(body, transcription) IS NOT NULL
                      ORDER BY seq DESC LIMIT 1)
                  ) AS body`,
          [data.tenantId, data.messageId, data.conversationId],
        );
        const pregunta = entrante.rows[0]?.body as string | null;
        if (pregunta) {
          const res = await searchKnowledge(client, {
            tenantId: data.tenantId,
            query: pregunta,
          });
          /**
           * Sin pedir la cita si la respuesta va DIRECTO al cliente (#1239).
           *
           * El modo se resuelve acá y no se adivina: `effectiveMode` es la
           * misma función que después decide si el agente contesta solo, así
           * que el bloque de conocimiento se arma con la misma verdad con la
           * que se va a usar. Una conversación en assist sigue recibiendo las
           * citas, que es lo que deja a quien atiende comprobar de dónde salió
           * cada afirmación antes de enviarla.
           */
          const modo = agenteDelTenant
            ? await effectiveMode(client, agenteDelTenant, data.tenantId, data.conversationId)
            : 'assist';
          knowledge = knowledgeContext(res, { citar: modo !== 'autonomous' });
          // `[]` si consultó y no encontró nada: eso es «lo dijo sin apoyarse en
          // ninguna fuente», y es distinto de `undefined` —el módulo apagado,
          // sin llaves, o el RAG caído— que es «no se sabe». La pantalla las
          // dice distinto.
          fuentes = fuentesCitadas(res);
        }
      } catch {
        /* el RAG caído no frena la sugerencia */
      }
    }
    // Las herramientas de lectura (#240). Existían declaradas, con su
    // ejecutor y sus tests, y no las llamaba NADIE: el mismo agujero que
    // denunciaba el issue, un piso más arriba. Acá se conectan.
    //
    // La identidad es la del DUEÑO de la conversación, no la del agente:
    // una herramienta jamás puede traer lo que esa persona no podría ver.
    // Una conversación sin dueño se queda sin herramientas, y está bien:
    // sin persona no hay permiso contra el cual verificar nada.
    const tools = await herramientasDeLaConversacion(client, data, colas.registry);
    // Los módulos activos del tenant: contra ellos se resuelve el objetivo
    // del agente (#315). Sin esto, un agente con objetivo asume que no hay
    // nada activo y avisa que no puede cumplirlo — falla hacia no prometer,
    // que es lo correcto, pero acá sí sabemos qué hay.
    const activeModules =
      colas.registry
        ?.health()
        .filter((m) => m.active)
        .map((m) => m.id) ?? [];

    // El modo autónomo primero (#49): responde SOLO cuando el dueño lo
    // permitió; si no toca (assist), cae a la sugerencia de siempre.
    const auto = await autoRespondForInbound(client, {
      tenantId: data.tenantId,
      conversationId: data.conversationId,
      knowledge,
      activeModules,
      /**
       * Las mismas herramientas que la sugerencia (#1235).
       *
       * Antes se calculaban acá y se le daban SOLO al camino de la sugerencia:
       * el autónomo corría sin ninguna y por eso el CRM quedaba vacío mientras
       * el bot atendía. `herramientasDeLaConversacion` ya decide con qué
       * identidad y con qué permisos; si no hay ninguna identidad, devuelve
       * solo las que no leen datos de nadie y el autónomo sigue como antes.
       */
      tools,
      ...(fuentes ? { fuentes } : {}),
      requestId: data.requestId,
    });
    // Lo que sale firmado al cliente — la respuesta autónoma o el aviso de
    // escalada (#1019) — se entrega igual: es respuesta a su entrante, así
    // que la ventana de 24 h está abierta y el horario de silencio no aplica.
    const entregar = async (body: string): Promise<string> => {
      const message = await sendMessage(client, {
        tenantId: data.tenantId,
        conversationId: data.conversationId,
        authorKind: 'agent',
        type: 'texto',
        body,
        delivery: 'reply',
        requestId: data.requestId,
      });
      const conv = await getConversation(client, data.tenantId, data.conversationId);
      if (!salePorProveedor(conv.channel)) {
        await updateDeliveryStatus(client, {
          tenantId: data.tenantId,
          messageId: message.id,
          status: 'sent',
          requestId: data.requestId,
        });
      }
      return message.id;
    };
    if (auto.action === 'escalated') {
      // El aviso viene armado y firmado desde el módulo (#1019): sin él, el
      // cliente que preguntó algo se quedaba mirando un chat mudo hasta que
      // un humano abriera la bandeja.
      const avisado = await entregar(auto.aviso);
      return { escalated: auto.reason, avisado, transcribed };
    }
    if (auto.action === 'reply') {
      // El cliente siempre ve QUIÉN escribe y cómo pedir humano (SPEC §13).
      // La firma la resuelve el módulo (#1227): sabe los límites del agente y
      // si ya habló en esta conversación, y desde #1242 también qué dice. Acá
      // solo se pega, y vacía no pega nada.
      const firmado = auto.firma ? `${auto.text}\n\n${auto.firma}` : auto.text;
      const autoReplied = await entregar(firmado);
      /**
       * El embudo, DESPUÉS de entregar (#1243).
       *
       * El orden es la mitad del asunto: el cliente ya tiene su respuesta
       * cuando esto corre, así que un CRM que falla o un permiso que falta no
       * le pueden quitar el mensaje. `abreLaOportunidad` además se come su
       * propio error y devuelve el motivo.
       */
      const conversacion = await getConversation(client, data.tenantId, data.conversationId);
      const nombre = conversacion.contactId
        ? ((await client.query(`SELECT name FROM contacts WHERE tenant_id = $1 AND id = $2`, [
            data.tenantId,
            conversacion.contactId,
          ])).rows[0]?.name as string | null) ?? null
        : null;
      const oportunidad = await abreLaOportunidad({
        tools,
        clasificacion: auto.clasificacion,
        datos: { nombreDelContacto: nombre, intencion: auto.clasificacion.intencion },
        yaTiene: async () => {
          const r = await client.query(
            `SELECT 1 FROM deals
              WHERE tenant_id = $1 AND source_conversation_id = $2 AND status = 'open'
              LIMIT 1`,
            [data.tenantId, data.conversationId],
          );
          return r.rowCount !== 0;
        },
      });
      if (oportunidad.motivo === 'falló') {
        console.warn(
          `copiloto: el visitante de ${data.conversationId} quería comprar y la oportunidad NO se creó: ` +
            `${oportunidad.detalle}`,
        );
      }
      return { autoReplied, oportunidad, transcribed };
    }
    if (auto.action === 'none') {
      return { skipped: 'sin agente activo', transcribed };
    }
    const suggestion = await suggestForInbound(client, {
      tenantId: data.tenantId,
      conversationId: data.conversationId,
      messageId: data.messageId,
      knowledge,
      tools,
      activeModules,
      ...(fuentes ? { fuentes } : {}),
      requestId: data.requestId,
    });
    return suggestion
      ? { suggestionId: suggestion.id, transcribed }
      : { skipped: 'el modelo no respondió', transcribed };
  });
}

/**
 * Las herramientas de lectura que este agente puede pedir en ESTA
 * conversación (#240).
 *
 * Tres filtros, en este orden: lo que el agente tiene configurado, lo que
 * los módulos activos ofrecen (`allowedToolsFor`), y el permiso de la
 * persona dueña de la conversación —ese último lo verifica
 * `ejecutarHerramienta` en cada llamada, no acá, porque el permiso de
 * alguien puede cambiar mientras la conversación sigue abierta.
 */
async function herramientasDeLaConversacion(
  client: PoolClient,
  data: SuggestJob,
  registry?: ModuleRegistry,
): Promise<HerramientaExpuesta[]> {
  if (!registry) return [];
  const agent = await activeAgent(client, data.tenantId);
  if (!agent) return [];

  const conv = await getConversation(client, data.tenantId, data.conversationId);
  const delaConversacion = (conv as { ownerId?: string | null }).ownerId ?? null;
  const configurada = guardrailLimits(agent).actuaComoUserId;

  /**
   * La identidad con la que trabaja el agente (#1235).
   *
   * El dueño de la conversación primero; si no tiene —y en autónomo
   * normalmente no tiene—, la que el negocio configuró en
   * `limits.actua_como_user_id`. Sin ninguna, null y pasa lo de antes: solo
   * las herramientas que no leen datos de nadie.
   *
   * El orden importa: si alguien del equipo tomó la conversación, manda ESA
   * persona. La identidad configurada es el respaldo para lo que nadie tomó,
   * no una forma de actuar a nombre de otro cuando hay un responsable.
   *
   * Y la configurada se COMPRUEBA antes de usarla. Creí que no hacía falta
   * —«sin rol no hay permisos»— y la prueba me mostró que estaba mirando el
   * nivel equivocado: `herramientasExpuestas` ofrece las herramientas por lo
   * que el agente tiene habilitado, y el permiso se verifica recién al
   * EJECUTAR. Así que un id mal configurado no abría ninguna puerta —cada
   * llamada habría sido rechazada— pero le daba al modelo un juego de
   * herramientas que fallan todas, y el dueño vería un bot que intenta y no
   * logra nada, sin una línea que lo explique.
   */
  let dueno = delaConversacion;
  if (!dueno && configurada) {
    const suyos = await permisosDe(client, data.tenantId, configurada, registry);
    if (suyos.size > 0) {
      dueno = configurada;
    } else {
      console.warn(
        `copiloto: el agente ${agent.id} de ${data.tenantId} dice actuar como ${configurada}, ` +
          'y esa persona no tiene permisos en este negocio. Se sigue sin herramientas: ' +
          'revisa `limits.actua_como_user_id`.',
      );
    }
  }

  /**
   * Sin dueño NO es sin herramientas (#715).
   *
   * Acá había un `if (!dueno) return []`, y una conversación nueva nace sin
   * dueño: el bot contestaba el primer mensaje —el que más importa— sin poder
   * buscar el conocimiento del negocio ni un precio. Recién se volvía útil
   * cuando alguien la asignaba, que es cuando ya hay una persona atendiendo.
   *
   * Ahora `herramientasExpuestas` decide: con dueño, todo lo que esa persona
   * pueda; sin dueño, solo lo del NEGOCIO —`HERRAMIENTAS_SIN_DUENO`—, que no
   * lee datos de nadie. La decisión vive allá y no acá, para que haya un solo
   * lugar donde esté escrita.
   */
  const permisos = dueno
    ? await permisosDe(client, data.tenantId, dueno, registry)
    : new Set<string>();

  /**
   * Las dependencias que NECESITAN una persona.
   *
   * Solo las usan herramientas que piden dueño —ofrecer horarios, crear una
   * tarea, crear una oportunidad— y ninguna de esas está en
   * `HERRAMIENTAS_SIN_DUENO`, así que en este camino no se llaman nunca.
   *
   * Revienta en vez de pasar una cadena vacía: si algún día alguien agrega a
   * esa lista una herramienta que sí necesita dueño, quiero un error con nombre
   * y no una tarea creada a nombre de nadie.
   */
  const conDueno = (para: string): string => {
    if (!dueno) throw new Error(`"${para}" necesita un dueño en la conversación y no lo hay.`);
    return dueno;
  };

  return herramientasExpuestas(
    client,
    {
      tenantId: data.tenantId,
      habilitadas: allowedToolsFor(agent, registry),
      actorUserId: dueno,
      agentId: agent.id,
      conversationId: data.conversationId,
      requestId: data.requestId,
    },
    {
      actorPuede: (permiso) => permisos.has(permiso),
      habilitadas: allowedToolsFor(agent, registry),
      getContext: (conversationId) => getContext(client, data.tenantId, conversationId),
      buscarConocimiento: (query) => searchKnowledge(client, { tenantId: data.tenantId, query }),
      buscarProducto: (query) => getProduct(client, data.tenantId, query),
      horariosLibres: (dia) =>
        huecosConGoogle(client, { tenantId: data.tenantId, ownerId: conDueno('ofrecer horarios'), dia }),

      /**
       * Tomar la hora que el cliente eligió (ADR-0029).
       *
       * El fin NO viene del modelo: sale de la duración configurada del
       * hueco. Pedírselo sería darle una forma de agendar dos horas donde
       * caben treinta minutos.
       *
       * `exigirHuecoDisponible` es lo que vuelve defendible esto: la
       * validación ocurre DENTRO del cerrojo de `agendar`, con los huecos
       * recalculados. Entre que se ofrecieron y que la persona eligió pudo
       * entrar otra cita.
       */
      tomarLaHora: async (inicio) => {
        const cuando = new Date(inicio);
        if (!Number.isFinite(cuando.getTime())) throw new Error('Esa hora no se entiende.');
        const dueno = conDueno('tomar una hora');
        const dia = diaEn(await zonaDelTenant(client, data.tenantId), cuando);
        const huecos = await huecosConGoogle(client, { tenantId: data.tenantId, ownerId: dueno, dia });
        const elegido = huecos.find((h) => new Date(h.inicio).getTime() === cuando.getTime());
        if (!elegido) {
          throw new Error('Ese horario ya no está libre. Mira los horarios de nuevo y ofrece otro.');
        }
        const contactId = conv.contactId;
        if (!contactId) throw new Error('Esta conversación todavía no tiene una ficha asociada.');
        const cita = await agendar(client, {
          tenantId: data.tenantId,
          contactId,
          ownerId: dueno,
          inicio: cuando,
          fin: new Date(elegido.fin),
          // Confirmada y con la conversación: así entra al barrido de
          // recordatorios (#1249). Una cita `proposed` no recibe aviso, que
          // es el mismo agujero con otro nombre.
          confirmada: true,
          conversationId: data.conversationId,
          exigirHuecoDisponible: true,
          actor: dueno,
          actorKind: 'agent',
          ...(data.requestId ? { requestId: data.requestId } : {}),
        });
        return { id: cita.id, inicio: cita.startsAt, fin: cita.endsAt };
      },

      // Las dos que ESCRIBEN (ADR-0017): quedan adentro del negocio y se
      // deshacen. El contacto no lo elige el modelo — sale de la
      // conversación, porque un nombre mal leído terminaría creándole una
      // oportunidad a otra persona.
      contactoDeLaConversacion: async () => conv.contactId ?? null,

      // Quién es y qué le pasó antes (#440). Sin esto el asistente volvía a
      // preguntar lo que el negocio ya sabía: estaban declaradas en el
      // manifiesto de crm y no las implementaba nadie.
      buscarContacto: async (query) => {
        const { items } = await listContacts(client, data.tenantId, { q: query, limit: 5 });
        // Lo mínimo para reconocer a alguien. La ficha entera es más de lo
        // que hace falta para saludar por su nombre, y lo que no se manda
        // no se puede filtrar.
        return items.map((c) => ({
          contactId: c.id,
          nombre: c.name,
          telefono: c.phone,
          desde: c.lastActivityAt,
          ultimaActividad: c.lastActivityAt,
        }));
      },
      historialDelContacto: async (contactId) => {
        // Lo mismo que en `datosDelNegocioParaLaIa`: en serie —el cliente de
        // pg las encolaba igual— y cada lectura opcional con su savepoint, que
        // es lo que hace que una tabla que falta no se lleve el resto (#966).
        const sinRomper = <T>(leer: (c: PoolClient) => Promise<T>, vacio: T, que: string) =>
          degradarSinRomper(client, leer, (error) => {
            console.warn(
              `copilot: no se pudo leer ${que} de ${contactId} en ${data.tenantId}; el historial ` +
                `sale sin esa parte. Causa: ${error.message}`,
            );
            return vacio;
          });
        const oportunidades = await sinRomper(
          (c) => listDeals(c, data.tenantId, { contactId, limit: 5 }).then((r) => r.items),
          [] as Awaited<ReturnType<typeof listDeals>>['items'],
          'las oportunidades',
        );
        const actividades = await sinRomper(
          (c) => listActivitiesByContact(c, data.tenantId, contactId),
          [] as Awaited<ReturnType<typeof listActivitiesByContact>>,
          'las actividades',
        );
        const citas = await sinRomper(
          (c) =>
            listarCitas(c, {
              tenantId: data.tenantId,
              desde: new Date(Date.now() - 365 * 86_400_000),
              hasta: new Date(Date.now() + 90 * 86_400_000),
            }),
          [] as Awaited<ReturnType<typeof listarCitas>>,
          'las citas',
        );
        const camposPropios = await datosDelNegocioParaLaIa(client, data.tenantId, contactId);
        return {
          oportunidades: oportunidades.map((d: { title: string; status: string; valueClp: number | null }) => ({
            titulo: d.title,
            estado: d.status,
            valor: d.valueClp,
          })),
          actividades: actividades
            .slice(0, 5)
            .map((a: { type: string; title: string; dueAt: Date | null; createdAt: Date }) => ({
              tipo: a.type,
              titulo: a.title,
              cuando: a.dueAt ?? a.createdAt,
            })),
          citas: citas
            .filter((c: { contactId: string }) => c.contactId === contactId)
            .map((c: { startsAt: Date; status: string }) => ({ cuando: c.startsAt, estado: c.status })),
          // Solo si hay alguno: una llave vacía en el contexto es una línea
          // más que el modelo lee y paga sin que diga nada.
          ...(Object.keys(camposPropios).length > 0 ? { datosDelNegocio: camposPropios } : {}),
        };
      },
      crearActividad: (i) =>
        createActivity(client, {
          tenantId: data.tenantId,
          contactId: i.contactId,
          type: (['nota', 'tarea', 'llamada', 'reunion'].includes(i.type)
            ? i.type
            : 'nota') as 'nota',
          title: i.title,
          body: i.body,
          // Sin dueño explícito queda a nombre de quien atiende: una tarea
          // sin responsable es una tarea que no hace nadie.
          ownerId: conDueno('crear una tarea'),
          dueAt: i.dueAt ? new Date(`${i.dueAt}T12:00:00Z`) : undefined,
        }),
      crearOportunidad: async (i) => {
        const pipelines = await listPipelines(client, data.tenantId);
        const pipeline = pipelines[0];
        if (!pipeline) throw new Error('El negocio todavía no tiene un embudo configurado.');
        const deal = await createDeal(client, {
          tenantId: data.tenantId,
          contactId: i.contactId,
          pipelineId: pipeline.id,
          // Sin stageId: nace en la primera etapa ABIERTA (ADR-0017). La IA
          // no gana ni pierde negocios.
          title: i.title,
          value: i.value,
          ownerId: conDueno('crear una oportunidad'),
          sourceConversationId: data.conversationId,
          // Quién la creó. Faltaba desde #1243: el historial de etapa quedaba
          // con `actor NULL`, o sea que la oportunidad que abre el bot no
          // decía quién la abrió — justo en la herramienta cuya seguridad
          // entera es «la IA actúa con la identidad de una persona y queda
          // auditado».
          // Quién la creó. Faltaba desde #1243: `deal_stage_history.actor`
          // quedaba en NULL, o sea que la oportunidad que abre el bot no
          // decía quién la abrió — justo en la herramienta cuya seguridad
          // entera es «la IA actúa con la identidad de una persona».
          actor: conDueno('crear una oportunidad'),
          ...(data.requestId ? { requestId: data.requestId } : {}),
        });
        // El agente lo logró ÉL (#319). Es un hecho, no una inferencia: lo
        // acaba de hacer, en esta transacción y en esta conversación. Se
        // marca acá y no esperando el evento `deal.created`, porque ese
        // evento trae contactId y no conversationId — desde afuera no hay
        // forma de saber si lo hizo el agente o una persona.
        await marcarLogradoPorElAgente(client, {
          tenantId: data.tenantId,
          conversationId: data.conversationId,
          evento: 'deal.created',
          referencia: deal.id,
        });
        return deal;
      },
    },
  );
}

/**
 * Los permisos efectivos de la persona dueña de la conversación.
 *
 * Es la MISMA resolución que hace el guard de la API —rol base contra el
 * catálogo, o los permisos del rol a medida—, porque si acá fuera distinta
 * la IA podría traer por un camino lo que la persona no puede ver por el
 * otro. Un usuario sin rol en el tenant no tiene permisos: conjunto vacío,
 * y ninguna herramienta corre.
 */
async function permisosDe(
  client: PoolClient,
  tenantId: string,
  userId: string,
  registry?: ModuleRegistry,
): Promise<Set<string>> {
  const rol = await roleOf(client, tenantId, userId);
  if (!rol) return new Set();
  if (isBaseRole(rol)) {
    const catalogo = new Set(registry ? registry.permissionsCatalog().keys() : []);
    return new Set([...catalogo].filter((p) => baseRoleHasPermission(rol, p, catalogo)));
  }
  return new Set(await customRolePermissions(client, tenantId, rol));
}
