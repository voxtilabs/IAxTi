import { Controller, Get, NotFoundException, Param, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { withTenant } from '@iaxti/db';
import { leerConCache } from '@iaxti/core';
import {
  cierreDeLaVentana,
  getConversationDetail,
  isWithinWindow,
  listInternalNotes,
  listMessages,
} from '@iaxti/module-conversations';
import {
  pendingSuggestion,
  porQueNoHaySugerencia,
} from '@iaxti/module-agents';
import { enrollmentsForContact, listSequences } from '@iaxti/module-automations';
import { contactTags, getContactFicha } from '@iaxti/module-crm';
import {
  analisisDeConversacion,
  limitesDeAdjuntoDe,
  retencionVigente,
} from './piezas-compartidas';
import {
  listCompanies,
  listCustomFields,
  listTags,
} from '@iaxti/module-crm';
import { listQuickReplies } from '@iaxti/module-conversations';
import { listNotifications } from '@iaxti/module-notifications';
import {
  accesoAlModulo,
  modulosDelPlan,
  modulosVendibles,
  zonaDelTenant,
} from '@iaxti/module-organizations';
import { RequireModule, RequirePermission } from './authz/decorators';
import type { Actor, WithUser } from './authz/authz.guard';
import { permisosDelActor, permisosDelActorConEstado } from './authz/can';
import { apiPool, apiRedis } from './db';
import { registry } from './registry';

/**
 * Abrir una conversación en UNA llamada (#761).
 *
 * ## Por qué existe
 *
 * Medido: abrir la bandeja son 7 llamadas a `/v1`, y abrir una conversación
 * suma 14 más. Ninguna repetida — son 21 endpoints distintos, así que no hay
 * duplicados que quitar; lo que queda es agrupar.
 *
 * Y el costo por llamada no es un viaje a la base: **son cuatro.** Toda ruta
 * pasa por `withTenant`, que hace `BEGIN`, `set_config('app.tenant_id')`, la
 * consulta y `COMMIT`. Con los 64 ms de viaje que midió #711 —la base está
 * lejos del VPS— 21 llamadas son ≥ 84 statements, o sea ≈ 5,4 s de puro viaje
 * sin una sola consulta lenta a la que culpar.
 *
 * Por eso esto arma TODO dentro de una sola transacción. Si abriera una por
 * pieza, agruparía las llamadas HTTP y no las transacciones: el presupuesto de
 * llamadas se vería verde y la pantalla seguiría igual de lenta. Es la forma de
 * equivocarse que se ve bien, y hay una prueba que cuenta los `BEGIN`.
 *
 * ## Por qué las rutas sueltas se quedan
 *
 * No se reemplaza nada: el SDK las usa y quien recarga UNA cosa —las notas
 * después de escribir una— no tiene por qué volver a pedir los mensajes. El
 * arranque se agrega.
 *
 * ## Cómo degrada
 *
 * Un arranque son muchos permisos: la sugerencia pide uno, el análisis otro, las
 * secuencias otro. Un 403 global por la pieza más exigente dejaría la pantalla
 * sin lo que la persona SÍ puede ver, así que cada pieza responde por su cuenta
 * y **se distingue «no puedes verlo» de «no hay»**:
 *
 *   { estado: 'ok', dato: … }        lo tiene y acá está
 *   { estado: 'ok', dato: null }     no hay sugerencia vigente
 *   { estado: 'sin-permiso' }        tu rol no la ve
 *   { estado: 'modulo-apagado' }     este despliegue no la tiene
 *   { estado: 'falla' }              se cayó al cargarla: reintentable
 *
 * Un `null` pelado para los cuatro es lo que haría que la pantalla diga «no hay
 * sugerencias» a alguien que simplemente no tiene permiso para verlas.
 */

/**
 * Los TTL son los de las rutas sueltas, no unos nuevos.
 *
 * Comparten CLAVE de caché con ellas, así que un TTL distinto acá no hace «otra
 * caché»: hace que el mismo dato se sirva viejo por un tiempo distinto según la
 * puerta por la que se pidió. `/tags` usa 120 y `/campos` 120 (#711).
 */
const TTL_ETIQUETAS = 120;
const TTL_CAMPOS = 120;
const TTL_ACCESO = 300;
const TTL_RETENCION = 300;

function pool() {
  const p = apiPool();
  if (!p) {
    throw new NotFoundException({ code: 'DB_NOT_CONFIGURED', message: 'Sin base de datos.' });
  }
  return p;
}

function actorOf(request: WithUser): Actor {
  return request.actor as Actor;
}

/** Lo que puede devolver una pieza del arranque. */
export type Pieza<T> =
  | { estado: 'ok'; dato: T }
  | { estado: 'sin-permiso' }
  | { estado: 'modulo-apagado'; modulo: string }
  | { estado: 'falla' };

/**
 * Resuelve una pieza respetando su módulo y su permiso.
 *
 * El orden importa: primero el módulo y después el permiso. Un módulo apagado no
 * tiene permisos que comprobar —su catálogo no está— y contestar «sin permiso»
 * ahí mandaría a alguien a pedirle a su ADMIN un rol que no va a servir de nada.
 *
 * ## Por qué un CONJUNTO de permisos y no `actorCan`
 *
 * `actorCan` es síncrono, y por eso no puede resolver un rol propio del negocio:
 * los permisos de un rol custom viven en la base, así que devuelve `false` para
 * todos. Con un rol custom (#73) el arranque entero volvía `sin-permiso` pieza
 * por pieza, y la pantalla lo dibujaba como «no puedes verlo»: sin candados de
 * plan, sin avisos, sin atajos, sin notas, y con el aviso de modo soporte
 * apagado — que es el peor de todos, porque es un aviso de privacidad.
 *
 * `permisosDelActor` resuelve el conjunto completo con una consulta, y de paso
 * trata bien dos actores que `actorCan` sí maneja pero que acá conviene tener en
 * un solo lugar: la API key (sus scopes) y el soporte de IAxTi (un conjunto fijo
 * de solo lectura). Se resuelve UNA vez por petición, no una por pieza.
 */
async function pieza<T>(
  permisos: Set<string>,
  gates: { modulo?: string; permiso?: string },
  leer: () => Promise<T>,
): Promise<Pieza<T>> {
  if (gates.modulo && !registry.isActive(gates.modulo)) {
    return { estado: 'modulo-apagado', modulo: gates.modulo };
  }
  if (gates.permiso && !permisos.has(gates.permiso)) return { estado: 'sin-permiso' };
  /**
   * Una pieza que se cae NO se lleva el arranque (#761).
   *
   * Sin este `catch`, el `Promise.all` de abajo rechaza en cuanto una pieza
   * lanza y el endpoint entero contesta 500: un hipo de la base en las
   * secuencias dejaba la conversación sin abrir. Y eso es exactamente lo que
   * agrupar no puede hacer — antes cada llamada tenía su propio `.catch` en el
   * front, así que la que fallaba no se llevaba a las otras. Agrupar sin esto
   * ata la pantalla a la pieza más DÉBIL, igual que agruparlas en un solo
   * `await` la ataba a la más lenta (#690).
   *
   * `falla` es un estado propio y no se disfraza de «no hay»: la pantalla tiene
   * que poder decir «esto no cargó, reintenta» en vez de «no hay notas». Y el
   * error se registra, porque una pieza que se cae en silencio es una pieza que
   * nadie arregla.
   *
   * ## Lo que este `catch` NO puede arreglar, medido
   *
   * Si lo que falla es una CONSULTA, Postgres deja la transacción en estado
   * abortado y todo statement siguiente responde «current transaction is
   * aborted». Como las piezas comparten transacción —que es de dónde viene toda
   * la ganancia de #761—, una consulta caída se lleva a las demás por mucho
   * `catch` que haya. Comprobado: rompiendo la tabla de notas, la sugerencia y
   * el análisis también vuelven `falla`.
   *
   * Lo que el `catch` sí cambia, y por eso está: el endpoint contesta **200 con
   * cada pieza marcada** en vez de un 500 opaco. La pantalla puede decir qué no
   * cargó y recargar lo suyo por su ruta suelta —que se quedó justamente para
   * esto—; con un 500 no puede distinguir «se cayó una pieza» de «no existe la
   * conversación».
   *
   * Aislar de verdad cada pieza se puede: un `SAVEPOINT` antes y un `ROLLBACK TO
   * SAVEPOINT` al fallar. No se hizo, y la cuenta es la razón: son dos
   * statements más por pieza, y con trece piezas a 64 ms de viaje (#711) son
   * ~1,7 s agregados a cada arranque para cubrir un caso que, cuando ocurre,
   * significa que la base está mal. Pagar siempre por lo que casi nunca pasa es
   * exactamente lo que este issue vino a dejar de hacer.
   */
  try {
    return { estado: 'ok', dato: await leer() };
  } catch (err) {
    console.error(
      `arranque: la pieza ${gates.permiso ?? gates.modulo ?? 'sin nombre'} falló`,
      err,
    );
    return { estado: 'falla' };
  }
}

@ApiTags('arranque')
@Controller()
export class ArranqueController {
  /**
   * **LO URGENTE** de una conversación: el hilo, los mensajes y qué se puede
   * adjuntar. Nada más, y el «nada más» es la parte importante.
   *
   * ## Por qué esto no trae la ficha ni la sugerencia
   *
   * Agrupar las catorce llamadas en una sola parece la respuesta obvia a #761 y
   * es un error que este repositorio ya cometió y ya arregló. #690: abrir una
   * conversación eran seis llamadas con un solo `Promise.all`, así que la
   * pantalla esperaba a la ÚLTIMA. Una de las seis llamaba al proveedor de IA, y
   * el 28/09 ese proveedor se puso a encolar: la misma petición pasó de 2 s a
   * 170 s —medido con curl: 139 s y 178 s— y la bandeja entera quedaba en blanco
   * esperando al copiloto. El mensaje del cliente estaba en la mano y no se veía.
   *
   * Una respuesta agrupada vuelve a atar la pantalla a la pieza más lenta, y lo
   * hace peor que antes: dentro de una respuesta HTTP no hay forma de dibujar lo
   * que ya llegó. Las pruebas de #690 en `apps/web` existen justamente para
   * frenar a quien agrupe «porque ahí están las otras», y me frenaron a mí.
   *
   * Así que el arranque son DOS: este, que la pantalla espera, y
   * `:id/arranque/ficha`, que entra solo. Dos llamadas en vez de catorce, y el
   * hilo se dibuja sin esperar a nada que pueda tardar.
   *
   * ## La condición de las piezas de este endpoint
   *
   * Todo lo de acá es lectura de base. Si alguna vez una pieza de ESTE arranque
   * necesita hablar con un proveedor, no va acá: va al otro, o a su ruta suelta.
   *
   * La conversación misma NO es una pieza que degrada: si no existe o no es
   * tuya, esto es un 404 — igual que `GET /conversations/:id`, y con la misma
   * respuesta para los dos casos, porque «existe pero no es tuya» también es
   * información.
   */
  @Get('conversations/:id/arranque')
  @RequireModule('conversations')
  @RequirePermission('conversations.read')
  @ApiOperation({ summary: 'Lo urgente de una conversación: hilo, mensajes y adjuntos (#761)' })
  async conversacion(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    const noExiste = () => {
      throw new NotFoundException({
        code: 'CONVERSATION_NOT_FOUND',
        message: 'No encontramos esa conversación.',
      });
    };

    return withTenant(pool(), actor.tenantId, async (c) => {
      const permisos = await permisosDelActor(c, actor);
      const detalle = await getConversationDetail(c, actor.tenantId, id).catch(noExiste);
      // El dueño se comprueba UNA vez. Las rutas sueltas lo comprobaban cada
      // una por su cuenta: `:id` y `:id/messages` hacían su propia consulta de
      // la conversación solo para esto.
      if (
        !permisos.has('conversations.read_all') &&
        detalle.ownerId !== null &&
        detalle.ownerId !== actor.userId
      ) {
        noExiste();
      }

      return {
        conversacion: {
          ...detalle,
          // La ventana la decide la API, no la pantalla (#639): la bandeja la
          // calculaba por su cuenta sin mirar el canal, y en webchat —que no
          // tiene ventana— escondía el campo de respuesta.
          ventanaAbierta: isWithinWindow(detalle.channel, detalle.lastInboundAt),
          cierraA: cierreDeLaVentana(detalle.channel, detalle.lastInboundAt),
        },
        // No pasa por `pieza` porque no consulta nada: sale del canal. Y la
        // forma la arma `piezas-compartidas`, la MISMA que sirve la ruta suelta
        // — rearmarla acá devolvía el arreglo pelado y el chat reventaba en el
        // render, porque un arreglo es truthy y el `?.limites` no cortaba.
        limitesDeAdjunto: limitesDeAdjuntoDe(detalle.channel),
        mensajes: await pieza(permisos, {}, () => listMessages(c, actor.tenantId, id, 50)),
      };
    });
  }

  /**
   * **EL RESTO** de una conversación: lo que puede tardar y lo que puede faltar.
   *
   * La pantalla no espera esto (#690): lo pide junto con lo urgente y lo dibuja
   * cuando llega. Si no llega, el hilo ya está en pantalla y se puede responder,
   * que es lo que la persona vino a hacer.
   *
   * Hoy todas estas piezas son lecturas de base —`pendingSuggestion` y
   * `conversationAnalysis` leen lo que el worker del copiloto ya dejó escrito,
   * no generan nada—, así que agruparlas entre ellas no ata nada a un proveedor.
   * Lo que las separa del otro arranque es que **pueden** volver a tardar: la
   * generación vivió en este camino y puede volver.
   */
  @Get('conversations/:id/arranque/ficha')
  @RequireModule('conversations')
  @RequirePermission('conversations.read')
  @ApiOperation({ summary: 'El resto de una conversación: notas, copiloto y ficha (#761)' })
  async ficha(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    const noExiste = () => {
      throw new NotFoundException({
        code: 'CONVERSATION_NOT_FOUND',
        message: 'No encontramos esa conversación.',
      });
    };

    return withTenant(pool(), actor.tenantId, async (c) => {
      const permisos = await permisosDelActor(c, actor);
      const detalle = await getConversationDetail(c, actor.tenantId, id).catch(noExiste);
      if (
        !permisos.has('conversations.read_all') &&
        detalle.ownerId !== null &&
        detalle.ownerId !== actor.userId
      ) {
        noExiste();
      }

      const contactId = detalle.contactId ?? null;

      /**
       * Siete piezas: las tres de la conversación y las cuatro de la FICHA.
       *
       * Las cuatro de la ficha estuvieron fuera un rato, y con razón: ningún
       * componente las leía, así que el camino caliente pagaba
       * `getContactFicha` —tres consultas, una con LATERAL sobre
       * `deal_stage_history`— en cada apertura para tirar el resultado. Un
       * agregado que trae lo que nadie lee no es más rápido: es el mismo trabajo
       * cobrado en el peor momento.
       *
       * Vuelven porque ahora SÍ se leen: la bandeja se las pasa a `FichaContacto`
       * y a `SecuenciasFicha`, que antes las pedían por su cuenta —cuatro puertas
       * más, medidas en el e2e—. Y van con las mismas funciones que sus rutas
       * sueltas, sin rearmar nada: es exactamente donde este PR se rompió dos
       * veces.
       *
       * El viejo comentario de«tres piezas, no siete» queda como advertencia: si alguien
       * saca un consumidor, estas piezas tienen que salir con él.
       */
      const [
        notas,
        sugerencia,
        analisis,
        contacto,
        etiquetasDelContacto,
        inscripciones,
      ] = await Promise.all([
          pieza(permisos, { modulo: 'conversations', permiso: 'conversations.notes' }, () =>
            listInternalNotes(c, actor.tenantId, id),
          ),
          pieza(permisos, { modulo: 'agents', permiso: 'agents.use' }, async () => {
            const vigente = await pendingSuggestion(c, actor.tenantId, id);
            if (vigente) return { sugerencia: vigente, motivo: null };
            // El motivo se calcula SOLO cuando no hay sugerencia: en el camino
            // bueno no cuesta ni una consulta más.
            return {
              sugerencia: null,
              motivo: await porQueNoHaySugerencia(c, {
                tenantId: actor.tenantId,
                conversationId: id,
              }),
            };
          }),
          // PLANO y con `mode` en inglés y `marcaManual`: es el contrato que la
          // ficha ya lee. Rearmarlo acá como `{ analisis, modo }` la reventaba
          // y además perdía `marcaManual`, que es quién puso el piloto
          // automático (#697).
          pieza(permisos, { modulo: 'agents', permiso: 'conversations.read' }, () =>
            analisisDeConversacion(c, actor.tenantId, id),
          ),
        pieza(permisos, { modulo: 'crm', permiso: 'crm.contacts.read' }, () =>
          contactId ? getContactFicha(c, actor.tenantId, contactId) : Promise.resolve(null),
        ),
        pieza(permisos, { modulo: 'crm', permiso: 'crm.contacts.read' }, () =>
          contactId ? contactTags(c, actor.tenantId, contactId) : Promise.resolve([]),
        ),
        pieza(permisos, { modulo: 'automations', permiso: 'automations.enroll' }, () =>
          contactId ? enrollmentsForContact(c, actor.tenantId, contactId) : Promise.resolve([]),
        ),
      ]);

      return {
        notas,
        sugerencia,
        analisis,
        contacto,
        etiquetasDelContacto,
        inscripciones,
      };
    });
  }

  /**
   * Lo del shell: quién soy, qué módulos hay, a qué tengo acceso, y las listas
   * casi estáticas (#761).
   *
   * **No incluye la bandeja.** La lista de conversaciones tiene filtros, orden y
   * cursor; meterla acá obligaría al arranque a aceptar los mismos parámetros y
   * a volver a pedirse cada vez que alguien cambia un filtro — que es lo
   * contrario de arrancar una vez.
   *
   * **Tampoco incluye el estado del soporte**, y el motivo es una regla que
   * conviene tener escrita: *una pieza que tiene que estar FRESCA no entra en un
   * agregado que se pide una vez.* El arranque se pide al entrar y no se vuelve
   * a pedir, así que el soporte que entra diez minutos después no aparecería
   * nunca — infinitamente peor que el TTL de dos minutos que #711 rechazó por
   * esto mismo. El arranque sirve para lo que vale lo mismo en el segundo 1 y en
   * el minuto 20.
   *
   * **Y no incluye `/me`**, aunque el issue lo liste. Lo intenté y está mal por
   * dos motivos que solo se ven al medirlo:
   *
   *  · `tenantsOf` consulta `user_roles`, que tiene RLS. Dentro de esta
   *    transacción `app.tenant_id` está fijado, así que la lista de negocios
   *    volvía con UNO: el que ya estás mirando. El selector de negocio se
   *    quedaba sin los demás — un dato recortado es peor que uno ausente,
   *    porque nadie lo va a dudar.
   *  · Con `X-Api-Key` el actor es `apikey:<uuid>` y eso no entra en una columna
   *    uuid: la excepción nacía dentro del `Promise.all`, reventaba la
   *    transacción y el arranque entero contestaba 500. Una integración no podía
   *    usarlo nunca.
   *
   * Y el fondo es que `/me` es de otra clase: corre con `@RequireAuth()` SIN
   * tenant, porque es la llamada que contesta *cuáles* tenants hay. Meterla en
   * un agregado por tenant es pedirle la respuesta a quien ya la asumió. Son
   * 64 ms y una consulta; se queda en su ruta.
   */
  @Get('arranque')
  @RequirePermission('tenant.read')
  @ApiOperation({ summary: 'Todo lo que el shell necesita para abrir, en una llamada (#761)' })
  async shell(@Req() request: WithUser) {
    const actor = actorOf(request);

    return withTenant(pool(), actor.tenantId, async (c) => {
      const { permisos, resuelto } = await permisosDelActorConEstado(c, actor);
      const activos = registry.health().filter((m) => m.active);
      /**
       * La zona ANTES de abrir el paralelo, y en serie (#1092).
       *
       * `zonaDelTenant` degrada con `degradarSinRomper`, que usa savepoints:
       * son una pila y no admiten dos en vuelo sobre el mismo cliente (#991).
       * Abajo las piezas corren con un solo `PoolClient` compartido, así que
       * resolverla adentro hacía caer la pieza de retención cuando otra estaba
       * degradando al mismo tiempo — y en silencio, porque cada pieza atrapa
       * su fallo para no tumbar la pantalla.
       *
       * Acá cuesta una consulta cacheada cinco minutos, y una sola vez.
       */
      const zona = await zonaDelTenant(c, actor.tenantId);

      const [
        acceso,
        avisos,
        respuestasRapidas,
        etiquetas,
        campos,
        empresas,
        secuencias,
        retencion,
      ] = await Promise.all([
        pieza(permisos, { permiso: 'tenant.read' }, () =>
          leerConCache(
            apiRedis(),
            { clave: 'modulos:acceso', tenantId: actor.tenantId, ttlSegundos: TTL_ACCESO },
            async () => {
              /**
               * Con `c` y no con `pool()`.
               *
               * Las dos aceptan `Pick<Pool,'query'>`, así que pasarles el pool
               * «funcionaba» — y pedía DOS conexiones más mientras este
               * `withTenant` ya retiene una. El pool tiene máximo 6
               * (`DB_POOL_MAX`): con seis arranques a la vez, las seis quedan
               * retenidas por los `withTenant` y las consultas hijas esperan una
               * conexión que nadie va a soltar. Se traba hasta el timeout, y en
               * silencio, porque las dos traen `.catch(() => ({ rows: [] }))`.
               */
              const [vendibles, plan] = await Promise.all([
                modulosVendibles(c),
                modulosDelPlan(c, actor.tenantId),
              ]);
              return activos.map((m) => ({
                id: m.id,
                acceso: accesoAlModulo({ moduleId: m.id, vendibles, delPlan: plan.modulos }),
              }));
            },
          ),
        ),
        pieza(permisos, { modulo: 'notifications', permiso: 'notifications.manage_own' }, () =>
          listNotifications(c, actor.tenantId, actor.userId),
        ),
        // `conversations.reply` y no `read`: es el permiso de SU ruta. Agrupar
        // no puede aflojar un permiso — con `read` un rol de solo lectura
        // recibía por el arranque los atajos que su ruta propia le niega.
        pieza(permisos, { modulo: 'conversations', permiso: 'conversations.reply' }, () =>
          listQuickReplies(c, actor.tenantId, actor.userId),
        ),
        /**
         * Las casi estáticas conservan SU caché y SU TTL, cada una la suya
         * (criterio 5 de #761). Cachear el arranque entero con un TTL único
         * serviría avisos viejos y un estado de soporte viejo junto con las
         * etiquetas, que es lo único que de verdad aguanta estar viejo.
         */
        pieza(permisos, { modulo: 'crm', permiso: 'crm.contacts.read' }, () =>
          leerConCache(
            apiRedis(),
            // 120, el MISMO que `/tags`: con la misma clave de caché y TTL
            // distinto, la lista se servía vieja hasta 5 minutos por una puerta
            // y 2 por la otra, cambiando en silencio una decisión de #711.
            { clave: 'tags', tenantId: actor.tenantId, ttlSegundos: TTL_ETIQUETAS },
            () => listTags(c, actor.tenantId),
          ),
        ),
        pieza(permisos, { modulo: 'crm', permiso: 'crm.contacts.read' }, () =>
          leerConCache(
            apiRedis(),
            { clave: 'campos:todas', tenantId: actor.tenantId, ttlSegundos: TTL_CAMPOS },
            () => listCustomFields(c, actor.tenantId, undefined),
          ),
        ),
        pieza(permisos, { modulo: 'crm', permiso: 'crm.companies.read' }, () =>
          listCompanies(c, actor.tenantId, {}),
        ),
        /**
         * El catálogo de secuencias del negocio (#588).
         *
         * Estuvo en el arranque de la FICHA y de ahí salió un defecto de forma:
         * al cambiar de conversación hay que descartar todo lo del contacto
         * anterior, y si el catálogo viene por ese mismo camino hay que
         * descartarlo también —con su parpadeo— para traer lo idéntico.
         *
         * Las INSCRIPCIONES sí son del contacto y se quedan allá. Un dato vive
         * donde dice su alcance: ponerlo en el agregado del contacto obliga a
         * tratarlo como si cambiara con el contacto.
         */
        pieza(permisos, { modulo: 'automations', permiso: 'automations.enroll' }, () =>
          listSequences(c, actor.tenantId),
        ),
        // Con su caché y su TTL, como su ruta suelta: comparten clave, así que
        // servir esto sin cachear no es «más fresco», es inconsistente.
        pieza(permisos, { permiso: 'tenant.settings' }, () =>
          leerConCache(
            apiRedis(),
            { clave: 'retencion', tenantId: actor.tenantId, ttlSegundos: TTL_RETENCION },
            () => retencionVigente(c, actor.tenantId, zona),
          ),
        ),
      ]);

      return {
        // El catálogo del DESPLIEGUE, no «los módulos de quien mira» (#629):
        // sale del registry, es el mismo para todos y no consulta nada.
        modulos: activos.map((m) => {
          const manifiesto = registry.manifest(m.id);
          return { id: m.id, nav: manifiesto.nav ?? [], widgets: manifiesto.widgets ?? [] };
        }),
        /**
         * Lo que esta persona puede hacer, para que el menú no ofrezca
         * callejones sin salida (#814).
         *
         * Los 19 manifiestos declaran 25 entradas de `nav`, cada una con su
         * `permission`, y el campo no lo leía nadie: un USER veía las 25 y
         * quince de ellas exigen un permiso que no tiene. La página carga y
         * todas sus llamadas vuelven 403.
         *
         * `null` cuando el conjunto no se pudo RESOLVER —un rol propio cuyos
         * permisos no se pudieron leer—, y entonces el menú se dibuja
         * completo. «No tiene permisos» y «no pudimos averiguarlo» se ven
         * iguales y son cosas distintas: con la segunda, esconder el menú
         * deja a la persona sin nada y sin explicación. La API sigue siendo
         * la que manda.
         *
         * No es una decisión de seguridad: es de interfaz. El permiso se
         * aplica en cada ruta, y esto solo evita ofrecer la puerta.
         */
        permisos: resuelto ? [...permisos].sort() : null,
        acceso,
        avisos,
        respuestasRapidas,
        etiquetas,
        campos,
        empresas,
        secuencias,
        retencion,
      };
    });
  }
}
