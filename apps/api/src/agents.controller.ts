import {
  diagnosticarLaIa,
  semillaCacheada,
  CATALOGO_PARA_EL_DUENO,
  sirveParaEseAsistente,
  HERRAMIENTAS_DE_LECTURA,
  HERRAMIENTAS_QUE_ESCRIBEN_HABILITADAS,
} from '@iaxti/module-agents';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { withTenant } from '@iaxti/db';
import {
  DEFINICIONES,
  MODOS_DEL_ASISTENTE,
  OBJETIVOS,
  TASKS,
  costPerDay,
  costThisCycle,
  createAgent,
  getAgent,
  getQuota,
  herramientasExpuestas,
  iaSettings,
  listAgents,
  listExecutions,
  motivoDelProveedor,
  probarLaIa,
  type QuienFallo,
  PROVIDERS,
  providerAvailable,
  resolverObjetivo,
  runAgentTask,
  updateAgent,
} from '@iaxti/module-agents';
import { getTenantSettings, updateTenantSettings } from '@iaxti/module-organizations';
import { catalogoDeMetricas, metricaEnRango } from '@iaxti/module-analytics';
// El tipo de cambio sale del contrato de `billing`, que es su dueño (#575).
import { usdClpRate } from '@iaxti/module-billing';
import { z } from 'zod';
import {
  agenteQueConfigura,
  applyProposal,
  dismissProposal,
  pendingProposal,
  proposeConfiguration,
  evalGate,
  getAgent as getAgentContract,
  harvestFeedbackCases,
  listEvalCases,
  listEvalRuns,
  tasaDeObjetivo,
  intentosLogrados,
  casiLogrados,
  VENTANA_ATRIBUCION_DIAS,
  runEvaluation,
} from '@iaxti/module-agents';
import { ConflictException } from '@nestjs/common';
import type { Provider } from '@iaxti/module-agents';
import { RequireModule, RequirePermission } from './authz/decorators';
import { Cuerpo, horaRequerida, objetoCerrado, textoRequerido } from './validar';
import { actorCan } from './authz/can';
import type { Actor, WithUser } from './authz/authz.guard';
import { apiPool, apiRedis } from './db';
import { registry } from './registry';

function pool() {
  const p = apiPool();
  if (!p) {
    throw new ServiceUnavailableException({
      code: 'DB_NOT_CONFIGURED',
      message: 'El servidor aún no tiene base de datos configurada. Intenta más tarde.',
    });
  }
  return p;
}

const actorOf = (request: WithUser): Actor => request.actor as Actor;

/** El runtime de agentes (#47): configuración, corridas y consumo. */
/**
 * El fallo del proveedor, dicho como corresponde (#402).
 *
 * Antes todo lo que no fuera "falta la llave" caía en el genérico "algo
 * falló de nuestro lado" — que además miente sobre de qué lado está el
 * problema cuando lo que pasa es que el cliente se quedó sin saldo.
 *
 * `503` cuando reintentar tiene sentido y `409` cuando no: un 503 le dice
 * al cliente HTTP "vuelve a intentar", y con saldo cero eso es hacerle
 * perder el tiempo.
 */
function comoExcepcionDelProveedor(error: unknown, quien?: QuienFallo): never {
  const d = motivoDelProveedor(error, quien);
  const cuerpo = { code: `PROVIDER_${d.motivo.toUpperCase()}`, message: d.message };
  if (d.reintentable) throw new ServiceUnavailableException(cuerpo);
  throw new ConflictException(cuerpo);
}

/**
 * Los esquemas de entrada (#524), al lado de sus rutas.
 *
 * El mensaje va escrito acá porque lo lee quien está usando el asistente
 * —muchas veces con un cliente esperando— y no quien programa.
 *
 * Y el orden de las claves no es decorativo: zod informa los problemas en ese
 * orden y el puente usa el mensaje del PRIMERO, así que `task` va antes que
 * `prompt` — igual que los dos `if` que esto reemplazó, donde la tarea
 * inválida ganaba al texto que faltaba.
 */
const TareaDelAsistente = z.object({
  // El enum sale de la MISMA lista que usa el runtime: una tarea nueva en
  // `TASKS` queda aceptada acá sin tocar esta ruta, y el mensaje se arma con
  // esa lista como antes.
  task: z.enum(TASKS, { error: `La tarea es una de: ${TASKS.join(', ')}.` }),
  prompt: textoRequerido('Falta el texto de entrada.'),
  context: z.string().optional(),
});

const PreguntaAlAsistente = z.object({
  pregunta: textoRequerido('Falta la pregunta.'),
});

const DescripcionDelNegocio = z.object({
  description: textoRequerido('Cuéntanos primero de qué se trata el negocio.'),
  vertical: z.string().optional(),
});

/**
 * Los ajustes de IA del negocio (#536).
 *
 * Solo DOS cosas, y las dos son promesas que el producto ya hacía:
 *
 * - `soloProveedor`: el resguardo de ADR-0025 §7. Un cliente que exige por
 *   escrito un único proveedor de IA —una pyme con contrato de datos, o que
 *   simplemente no quiere que la conversación con sus clientes pase por cierto
 *   proveedor— no tenía forma de conseguirlo: `iaSettings` lo LEÍA y ninguna
 *   ruta lo escribía, así que solo se podía aplicar con un UPDATE a mano en
 *   producción. Y el ADR declaraba el problema resuelto, o sea que nadie iba a
 *   revisarlo: quien recibiera ese pedido iba a buscar la pantalla y no la iba a
 *   encontrar.
 * - `redactPII`: si los datos personales se tapan antes de mandar trazas al
 *   observador de IA (SPEC §13).
 *
 * Lo que NO se expone, a propósito: el modelo por tarea (`tasks`) y el modelo
 * económico. Son perillas de quien conoce los modelos, y ADR-0025 puso al
 * Agente General como la vía de configuración justamente para no llenar la
 * interfaz de perillas que un dueño de pyme no puede evaluar. Se siguen
 * respetando si están escritas; lo que no hay es pantalla para ponerlas.
 */
const AjustesDeIa = objetoCerrado(
  {
    soloProveedor: z
      .enum(PROVIDERS, { error: `El proveedor es uno de: ${PROVIDERS.join(', ')}.` })
      .nullable(),
    redactPII: z.boolean({ error: 'Dinos si tapamos los datos personales, sí o no.' }).optional(),
  },
  'los ajustes de IA',
);

/**
 * El pulso del evento (#1210), con forma (#1232).
 *
 * Las tres primeras llaves van JUNTAS y obligatorias porque `configDelPulso`
 * devuelve `null` —o sea, pulso apagado— si falta cualquiera: un `pulso` con
 * `activo: true` y sin horario queda prendido en la pantalla y mudo en el
 * motor, que es el defecto exacto de este issue en la función que más rápido
 * puede costar un número de WhatsApp.
 *
 * Los rangos salen de lo que ese archivo ya midió, no de un gusto:
 *
 * - `cada_minutos` entre 5 y 720. Abajo de 5 no es «retomar», es el mismo
 *   número escribiéndole a la misma persona cada rato; arriba de 720 no cabe
 *   ni un pulso en la ventana de un día, así que sería «prendido y nunca
 *   manda» — silencio otra vez.
 * - `max_por_persona` hasta 12. Entre 8:30 y 18:00 caben CATORCE pulsos de 40
 *   minutos, y el comentario de `pulso.ts` dice que catorce mensajes del mismo
 *   número al mismo teléfono en un día es exactamente el patrón que Meta mira.
 *   El tope del esquema queda abajo de ese número, no en él.
 */
const PulsoDelEvento = objetoCerrado(
  {
    activo: z.boolean({ error: 'Dinos si el pulso va prendido o apagado, sí o no.' }),
    desde: horaRequerida('La hora en que empieza el pulso va como HH:MM, por ejemplo 08:30.'),
    hasta: horaRequerida('La hora en que termina el pulso va como HH:MM, por ejemplo 18:00.'),
    cada_minutos: z
      .int({ error: 'Los minutos entre pulsos van en números enteros.' })
      .min(5, 'Entre un pulso y el siguiente tienen que pasar al menos 5 minutos.')
      .max(720, 'Más de 720 minutos entre pulsos no alcanza para mandar ninguno en el día.')
      .optional(),
    max_por_persona: z
      .int({ error: 'El tope de pulsos por persona va en números enteros.' })
      .min(1, 'El tope de pulsos por persona es de 1 a 12.')
      .max(12, 'El tope de pulsos por persona es de 1 a 12: más es insistir, no retomar.')
      .optional(),
  },
  'el pulso del asistente',
);

/**
 * Los guardrails del asistente (#1232).
 *
 * Son exactamente las llaves que `guardrailLimits` y `configDelPulso` LEEN, con
 * el rango que esos lectores respetan. Lo que había antes era un `jsonb` libre:
 * `confidence_threshold: 5` se guardaba, la pantalla mostraba 5 y la IA
 * escalaba con 0,7 — el dueño configuró una cosa y el producto hizo otra, sin
 * un aviso en ninguna parte.
 *
 * Los rangos, uno por uno, y de dónde sale cada uno:
 *
 * - `confidence_threshold` en (0, 1]: es la probabilidad con que el modelo
 *   contesta, y `guardrailLimits` descarta todo lo que no esté ahí.
 * - `max_agent_turns` de 1 a 50: el lector solo exige «> 0», y por eso un 500
 *   —un 5 con un dedo pesado— apagaba el guardrail entero sin decirlo. 50
 *   turnos sin avanzar ya es una conversación que nadie tiene.
 * - `money_limit_clp` entero y sobre 0, o `null`. El 0 NO se acepta: el lector
 *   lo convierte en «sin tope», que es lo contrario de lo que escribe alguien
 *   que pone 0. Para dejarlo sin tope se omite la llave o se manda `null`, y el
 *   mensaje lo dice.
 * - `escalation_notice` acepta el texto EN BLANCO, que es lo que hoy significa
 *   «usa el texto por defecto» (`autonomous.ts`), con un techo de 500: es un
 *   mensaje de WhatsApp, no una carta.
 * - `handoff_user_id` con forma de uuid: va derecho a `requestHandoff` como
 *   dueño de la conversación, y cualquier otro texto se traga el handoff.
 */
const LimitesDelAsistente = objetoCerrado(
  {
    confidence_threshold: z
      .number({ error: 'La confianza mínima va en número, entre 0 y 1.' })
      .gt(0, 'La confianza mínima va entre 0 y 1 —por ejemplo 0,7— y no puede ser 0.')
      .max(1, 'La confianza mínima va entre 0 y 1 —por ejemplo 0,7—: 1 es lo más exigente.')
      .optional(),
    max_agent_turns: z
      .int({ error: 'Los turnos sin avanzar van en números enteros.' })
      .min(1, 'Los turnos sin avanzar van de 1 a 50.')
      .max(50, 'Los turnos sin avanzar van de 1 a 50: con más, deja de ser un resguardo.')
      .optional(),
    money_limit_clp: z
      .int({ error: 'El tope de dinero va en pesos, sin decimales.' })
      .positive(
        'El tope de dinero va en pesos y sobre 0. Déjalo en blanco si quieres que escale ' +
          'ante cualquier monto.',
      )
      .nullable()
      .optional(),
    handoff_user_id: z
      .uuid('Elige a quién le queda la conversación de la lista de tu equipo.')
      .nullable()
      .optional(),
    escalation_notice: z
      .string({ error: 'El aviso de escalada va en texto.' })
      .max(500, 'El aviso de escalada es un mensaje, no una carta: hasta 500 caracteres.')
      .optional(),
    pulso: PulsoDelEvento.optional(),
  },
  'los límites del asistente',
);

/**
 * El horario autónomo (#1232).
 *
 * `inAutonomousHours` devuelve false —o sea, la IA no contesta sola nunca— si
 * falta `start` o falta `end`, y la pantalla de modo autónomo podía mandar uno
 * sin el otro: quien escribía solo el «desde» quedaba con el modo prendido, el
 * badge «Por horario» en verde y el asistente sin contestar jamás.
 *
 * De ahí las dos reglas que no son de forma sino de sentido:
 *
 * - **los dos o ninguno**: `{}` sigue siendo válido y significa «nunca sola»,
 *   que es el valor con que nace un asistente (SPEC §13, ADR-0010);
 * - **`days` con al menos un día**: `days: []` también es «nunca», pero
 *   escrito como si fuera una configuración. Si alguien apaga los siete días,
 *   lo que quiere es apagar el modo, y eso se dice en `defaultMode`.
 */
const HorarioAutonomo = objetoCerrado(
  {
    start: horaRequerida('La hora de inicio va como HH:MM, por ejemplo 19:00.').optional(),
    end: horaRequerida('La hora de término va como HH:MM, por ejemplo 09:00.').optional(),
    days: z
      .array(
        z
          .int({ error: 'Los días van en números, del 0 (domingo) al 6 (sábado).' })
          .min(0, 'Los días van del 0 (domingo) al 6 (sábado).')
          .max(6, 'Los días van del 0 (domingo) al 6 (sábado).'),
      )
      .max(7, 'La semana tiene siete días.')
      .optional(),
  },
  'el horario autónomo',
)
  .refine((h) => (h.start === undefined) === (h.end === undefined), {
    error:
      'El horario necesita las dos horas, desde y hasta: con una sola, tu asistente no ' +
      'contestaría sola nunca.',
    path: ['end'],
  })
  .refine((h) => h.days === undefined || h.days.length > 0, {
    error:
      'Elige al menos un día. Sin días marcados tu asistente no contestaría sola nunca; para ' +
      'apagarla, cambia el modo a «Solo sugiere».',
    path: ['days'],
  });

/**
 * Lo que se puede escribir del asistente, y es el cuerpo de las DOS rutas de
 * escritura (#1232).
 *
 * Antes eran `@Body() body: AgentInput` y `@Body() body: Partial<AgentInput> &
 * { active?: boolean }` — una declaración de TypeScript, que no comprueba nada
 * en ejecución, y que además dejaba al Agente General sin argumentos: el
 * generador del catálogo no sabe leer un tipo de intersección, así que
 * `AgentsController_update` publicaba solo `id` mientras la pantalla de detalle
 * le promete al dueño «para cambiarlo, pídeselo conversando».
 *
 * Los dos enums salen de las MISMAS listas que usa el runtime
 * (`PROVIDERS`, `MODOS_DEL_ASISTENTE`, `OBJETIVOS`), así que agregar un
 * proveedor o un objetivo no pide tocar este archivo.
 *
 * `objetivo` y `objetivoDetalle` NO aceptan `null` a propósito, aunque el tipo
 * del módulo lo permita: `updateAgent` escribe con `COALESCE($16, objetivo)`,
 * o sea que un `null` significa «no lo cambies» y no «bórralo». Aceptarlo
 * sería prometer un borrado que no ocurre — el mismo silencio que este issue
 * viene a cerrar. Para dejarlos como están, se omite la llave.
 */
const CAMPOS_DEL_ASISTENTE = {
  name: textoRequerido('El asistente necesita un nombre visible.').max(
    80,
    'El nombre del asistente es el que ve el cliente: hasta 80 caracteres.',
  ),
  personality: z
    .string({ error: 'La personalidad va en texto.' })
    .max(2000, 'La personalidad va en pocas líneas: hasta 2.000 caracteres.')
    .optional(),
  language: z
    .string({ error: 'El idioma va como código, por ejemplo es-CL.' })
    .regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'El idioma va como código, por ejemplo es-CL.')
    .optional(),
  provider: z
    .enum(PROVIDERS, { error: `El proveedor es uno de: ${PROVIDERS.join(', ')}.` })
    .optional(),
  model: textoRequerido('Dinos con qué modelo tiene que contestar.').max(120).optional(),
  promptName: z.string({ error: 'El nombre del prompt va en texto.' }).max(120).optional(),
  promptVersion: z.string({ error: 'La versión del prompt va en texto.' }).max(60).optional(),
  fallbackSystemPrompt: z
    .string({ error: 'El prompt de respaldo va en texto.' })
    .max(20_000, 'El prompt de respaldo no puede pasar de 20.000 caracteres.')
    .optional(),
  /*
   * Acá va la FORMA y no la política.
   *
   * Que cada herramienta sirva PARA ESTE asistente —las cifras del negocio no
   * son de uno que atiende clientes (#410, #1285)— se comprueba en el handler
   * y no acá, porque depende del objetivo del agente que está en la base y del
   * que puede venir cambiado en el mismo cuerpo. Un esquema no lo puede saber.
   *
   * Son dos capas a propósito, no una duplicación: esto rechaza un cuerpo mal
   * formado antes de tocar la base, y el handler rechaza una combinación que
   * no corresponde. Unificarlas obligaría a una de las dos a hacer el trabajo
   * de la otra mal.
   */
  allowedTools: z
    .array(z.string({ error: 'Cada herramienta va por su nombre, en texto.' }))
    .max(200, 'Son demasiadas herramientas para un asistente.')
    .optional(),
  defaultMode: z
    .enum(MODOS_DEL_ASISTENTE, {
      error: `El modo es uno de: ${MODOS_DEL_ASISTENTE.join(', ')}.`,
    })
    .optional(),
  autonomousHours: HorarioAutonomo.optional(),
  limits: LimitesDelAsistente.optional(),
  objetivo: z
    .enum(OBJETIVOS, { error: `El objetivo es uno de: ${OBJETIVOS.join(', ')}.` })
    .optional(),
  objetivoDetalle: z
    .string({ error: 'El detalle del objetivo va en texto.' })
    .max(200, 'El detalle del objetivo va en una frase: hasta 200 caracteres.')
    .optional(),
};

const AsistenteNuevo = objetoCerrado(CAMPOS_DEL_ASISTENTE, 'el asistente');

const CambiosDelAsistente = objetoCerrado(
  {
    ...CAMPOS_DEL_ASISTENTE,
    // Lo único obligatorio al crear es el nombre, y al editar no: un PUT que
    // solo cambia el modelo no tiene por qué repetirlo.
    name: CAMPOS_DEL_ASISTENTE.name.optional(),
    // `active` no está en `AgentInput` —apagar un asistente no es configurarlo—
    // pero `updateAgent` lo escribe, así que el cuerpo del PUT lo lleva.
    active: z.boolean({ error: 'Dinos si el asistente queda prendido o apagado, sí o no.' }).optional(),
  },
  'el asistente',
);

@ApiTags('agents')
@Controller('agents')
@RequireModule('agents')
export class AgentsController {
  /**
   * ¿Por qué la IA no hace nada? (#614)
   *
   * El canal tiene su diagnóstico desde #526 y ha servido cada vez. La IA no
   * tenía nada: si falta una llave, el modelo lanza, el error sube como «Algo
   * falló de nuestro lado» y nadie puede saber que el problema es una variable
   * de entorno ausente. Eso es lo que hace que alguien diga «nunca pude probar
   * nada» — no que no funcione, sino que no se puede ver por qué no.
   *
   * `channels.read` no sirve acá y `agents.configure` es demasiado: esto lo
   * tiene que poder mirar quien administra el negocio para saber si pedir ayuda,
   * sin poder cambiar con qué modelo se le contesta a sus clientes.
   */
  @Get('diagnostico')
  @RequireModule('agents')
  @RequirePermission('tenant.read')
  @ApiOperation({ summary: 'Por qué la IA no está trabajando, paso a paso' })
  async diagnostico(@Req() request: WithUser) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      const settings = await getTenantSettings(c, actor.tenantId);
      // El valor de ninguna llave sale de acá: `diagnosticarLaIa` solo pregunta
      // si la variable EXISTE. Un diagnóstico es una pantalla que alguien va a
      // compartir para pedir ayuda.
      return diagnosticarLaIa({ settings });
    });
  }

  /**
   * Probá la IA AHORA y decime qué pasó (#869).
   *
   * El `/diagnostico` de arriba, de #614, vino a arreglar «no se puede ver por
   * qué no funciona» — y lo arregló para una capa: la configuración. Qué
   * proveedor tiene cada tarea, cuál tiene credencial, qué pidió el negocio.
   *
   * La misma frase volvió entera un piso más abajo, y esta vez del dueño del
   * producto: «no puedes ver por qué demonios no funciona la IA dentro, si es
   * el núcleo y nunca he podido conversar con ella». Tenía razón. Las tres
   * verificaciones que había —`/ready`, este diagnóstico y `por-que-no-sugirio`—
   * mirán la configuración, una corrida pasada, o una variable no vacía.
   * Ninguna le habla al proveedor. Por eso 51 corridas fallidas en tres semanas
   * convivieron con todo en verde (#866): el sistema no parecía roto, parecía
   * vigilado.
   *
   * Esto hace UNA llamada de verdad, con el proveedor y modelo que esa tarea
   * usaría —el efectivo, con el respaldo de #665 aplicado— y cuenta qué volvió.
   * Es `POST` porque gasta plata, no porque cambie algo.
   *
   * El tope: una prueba por tenant cada minuto. Acá sí es por costo, a
   * diferencia de `probar-envio`, donde era por no llenarle el teléfono a una
   * persona. Y el mismo criterio que allá: si Redis no está, la prueba sale
   * igual. Cambiar «no puedo diagnosticar» por «no tengo Redis» sería el peor
   * negocio posible justo en la herramienta que existe para desatascar.
   *
   * Mismo permiso que el diagnóstico (`tenant.read`): quien paga la cuenta
   * tiene derecho a saber si lo que paga funciona, sin poder cambiar con qué
   * modelo se le contesta a sus clientes.
   */
  @Post('probar')
  @RequireModule('agents')
  @RequirePermission('tenant.read')
  @ApiOperation({ summary: 'Hace una llamada real al proveedor y dice exactamente qué pasó' })
  async probar(@Req() request: WithUser, @Body() body: { tarea?: string }) {
    const actor = actorOf(request);
    const redis = apiRedis();
    if (redis) {
      try {
        // `NX` + `EX` en una sola operación: con un `get` y después un `set`,
        // dos clics simultáneos pasan los dos y se paga dos veces.
        const puso = await redis.set(`probar-ia:${actor.tenantId}`, '1', 'EX', 60, 'NX');
        if (puso === null) {
          throw new BadRequestException({
            code: 'AI_TEST_TOO_SOON',
            message:
              'Ya probaste la IA hace menos de un minuto. Cada prueba le paga al proveedor, ' +
              'así que espera un poco antes de repetirla.',
          });
        }
      } catch (err) {
        if (err instanceof BadRequestException) throw err;
      }
    }
    const settings = await withTenant(pool(), actor.tenantId, (c) =>
      getTenantSettings(c, actor.tenantId),
    );
    // Ninguna llave sale de acá, igual que en el diagnóstico: lo que vuelve es
    // qué proveedor contestó y, si no contestó, el motivo ya clasificado.
    return probarLaIa({
      settings,
      ...(TASKS.includes(body?.tarea as never) ? { tarea: body.tarea as never } : {}),
    });
  }

  @Get('ajustes')
  @RequirePermission('tenant.settings')
  @ApiOperation({ summary: 'Los ajustes de IA del negocio: proveedor único y datos personales' })
  async ajustesDeIa(@Req() request: WithUser) {
    const actor = actorOf(request);
    const settings = await withTenant(pool(), actor.tenantId, (c) =>
      getTenantSettings(c, actor.tenantId),
    );
    const ia = iaSettings(settings);
    /**
     * Con qué se está atendiendo DE VERDAD, ahora (#858).
     *
     * `iaSettings(settings)` a secas devuelve lo que el negocio eligió. Esto
     * otro aplica lo que el producto de verdad hace: el defecto de la
     * plataforma —que desde #858 vive en la base—, el respaldo cuando falta
     * una credencial, y la transcripción que no puede ir a un proveedor de
     * solo texto aunque el negocio lo haya pedido.
     *
     * La pantalla lo necesita porque las tres cosas pasan sin que nadie las
     * anuncie: alguien que pidió «solo Gemini» y ve sus notas de voz
     * transcritas no tiene cómo saber que eso es correcto y está previsto.
     */
    const efectiva = await withTenant(pool(), actor.tenantId, async (c) =>
      iaSettings(settings, providerAvailable, undefined, await semillaCacheada(c)),
    );
    const atendiendo: Record<string, { provider: string; model: string }> = {};
    for (const [tarea, modelo] of Object.entries(efectiva.tasks)) {
      atendiendo[tarea] = { provider: modelo.provider, model: modelo.model };
    }
    return {
      soloProveedor: ia.soloProveedor,
      redactPII: ia.redactPII,
      // Cuáles tienen llave EN ESTE ambiente: elegir uno sin llave deja al
      // asistente sin contestar, y la pantalla tiene que poder decirlo antes.
      disponibles: PROVIDERS.filter((p) => providerAvailable(p)),
      atendiendo,
    };
  }

  @Put('ajustes')
  @RequirePermission('tenant.settings')
  @ApiOperation({ summary: 'Guarda el proveedor único y el trato de datos personales' })
  async guardarAjustesDeIa(
    @Req() request: WithUser,
    // Pasó de `validar` suelto a `@Cuerpo` (#1232): la comprobación es la
    // misma, pero solo el decorador registra el esquema, y sin registro el
    // catálogo publicaba esta operación con `properties: {}` — o sea que el
    // Agente General la ofrecía sin poder mandarle ni el proveedor. El cuerpo
    // ausente lo convierte el pipe en `{}`, y `soloProveedor` es obligatorio,
    // así que sigue siendo 400.
    @Cuerpo(AjustesDeIa) ajustes: z.infer<typeof AjustesDeIa>,
  ) {
    const actor = actorOf(request);
    // Sin llave no se guarda. Elegir un proveedor que este ambiente no tiene
    // deja al asistente sin contestar a cada mensaje, y el negocio no tiene
    // forma de saber por qué: mismo criterio que al subir un PDF sin el
    // proveedor multimodal (#522) — avisar ANTES, no después.
    if (ajustes.soloProveedor && !providerAvailable(ajustes.soloProveedor)) {
      const hay = PROVIDERS.filter((p) => providerAvailable(p));
      throw new BadRequestException({
        code: 'PROVIDER_UNAVAILABLE',
        message:
          `En este ambiente no hay llave para ${ajustes.soloProveedor}, así que tu asistente ` +
          'dejaría de contestar. ' +
          (hay.length ? `Con llave hoy: ${hay.join(', ')}.` : 'Hoy no hay ninguno configurado.'),
        details: [{ field: 'soloProveedor' }],
      });
    }
    return withTenant(pool(), actor.tenantId, async (c) => {
      // Se mezcla DENTRO de `ia`: `updateTenantSettings` hace `settings ||
      // patch`, que es merge de primer nivel, así que escribir `{ ia: {...} }`
      // pisaría `tasks` y `economico` — las dos perillas que esta pantalla no
      // muestra y que un negocio puede tener puestas.
      const actuales = (await getTenantSettings(c, actor.tenantId)) as {
        ia?: Record<string, unknown>;
      };
      const ia = { ...(actuales.ia ?? {}) };
      if (ajustes.soloProveedor === null) delete ia.soloProveedor;
      else ia.soloProveedor = ajustes.soloProveedor;
      if (ajustes.redactPII !== undefined) ia.redactPII = ajustes.redactPII;
      await updateTenantSettings(c, actor.tenantId, { ia });
      const guardado = iaSettings({ ia });
      return { soloProveedor: guardado.soloProveedor, redactPII: guardado.redactPII };
    });
  }

  @Get()
  @RequirePermission('agents.use')
  @ApiOperation({ summary: 'Asistentes del negocio' })
  async list(@Req() request: WithUser) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) => listAgents(c, actor.tenantId));
  }

  @Post()
  @RequirePermission('agents.configure')
  @ApiOperation({ summary: 'Crea un asistente (proveedor y modelo configurables)' })
  async create(
    @Req() request: WithUser,
    @Cuerpo(AsistenteNuevo) body: z.infer<typeof AsistenteNuevo>,
  ) {
    const actor = actorOf(request);
    try {
      return await withTenant(pool(), actor.tenantId, (c) =>
        createAgent(c, { ...body, tenantId: actor.tenantId, actor: actor.userId, requestId: request.requestId }),
      );
    } catch (err) {
      throw new BadRequestException({ code: 'AGENT_INVALID', message: (err as Error).message });
    }
  }

  @Put(':id')
  @RequirePermission('agents.configure')
  @ApiOperation({ summary: 'Edita el asistente — cambiar de modelo no es deploy' })
  async update(
    @Req() request: WithUser,
    @Param('id') id: string,
    @Cuerpo(CambiosDelAsistente) body: z.infer<typeof CambiosDelAsistente>,
  ) {
    const actor = actorOf(request);
    try {
      return await withTenant(pool(), actor.tenantId, async (c) => {
        /*
         * Las herramientas que manda se validan ACÁ y no solo en la pantalla
         * (#1285).
         *
         * La pantalla filtra por destinatario, pero una llave de API entra por
         * la misma puerta sin pasar por ninguna pantalla. Sin esta validación,
         * un `PUT` con `allowedTools: ['analytics.metrica']` sobre un asistente
         * de WhatsApp le colgaría las cifras del negocio a un bot que habla con
         * clientes — el agujero exacto que la #410 cerró por el otro lado.
         *
         * Y lo segundo: una herramienta que no existe se guardaba sin chistar.
         * No rompía nada porque `allowedToolsFor` la filtra después, pero el
         * dueño guardaba algo que no hacía nada y nadie se lo decía.
         */
        if (body.allowedTools !== undefined) {
          const agente = await getAgentContract(c, actor.tenantId, id);
          // El objetivo puede venir cambiado en el MISMO cuerpo, y entonces
          // manda el nuevo: validar contra el viejo rechazaría una
          // configuración legítima.
          const objetivo = body.objetivo === undefined ? agente.objetivo : body.objetivo;
          const destinatario = objetivo ? DEFINICIONES[objetivo].destinatario : ('cliente' as const);
          const malas = body.allowedTools.filter((t) => !sirveParaEseAsistente(t, destinatario));
          if (malas.length) {
            throw new BadRequestException({
              code: 'AGENT_TOOL_INVALID',
              message:
                `Estas no se le pueden dar a este asistente: ${malas.join(', ')}. ` +
                (destinatario === 'cliente'
                  ? 'Las cifras del negocio son del asistente del dueño, no de uno que atiende clientes.'
                  : 'Un asistente del dueño no toma ni mueve horas de clientes.'),
            });
          }
        }
        // El gate (#53): a una config con score MENOR no se pasa. Solo
        // bloquea cuando hay evaluaciones de ambas versiones.
        const cambiaConfig =
          body.provider !== undefined || body.model !== undefined || body.promptVersion !== undefined;
        if (cambiaConfig) {
          const agente = await getAgentContract(c, actor.tenantId, id);
          const gate = await evalGate(c, actor.tenantId, agente, {
            provider: body.provider ?? agente.provider,
            model: body.model ?? agente.model,
            promptVersion: body.promptVersion ?? agente.promptVersion,
          });
          if (!gate.allowed) {
            throw new ConflictException({
              code: 'EVAL_REGRESSION',
              message: `Esa versión rinde peor en la evaluación (${gate.candidata} vs ${gate.actual}). Mejora el prompt o el dataset antes de cambiar.`,
            });
          }
        }
        return updateAgent(c, {
          ...body,
          tenantId: actor.tenantId,
          agentId: id,
          actor: actor.userId,
          requestId: request.requestId,
        });
      });
    } catch (err) {
      if (err instanceof ConflictException) throw err;
      // Y el BadRequest que lanza la validación de herramientas: sin esta
      // línea se reenvolvía en `AGENT_INVALID` y su `message` —que es un
      // objeto, no una cadena— terminaba en el cuerpo como `undefined`. El
      // dueño veía «algo salió mal» en vez de qué herramienta no corresponde.
      if (err instanceof BadRequestException) throw err;
      const message = (err as Error).message;
      if (/No encontramos/.test(message)) throw new NotFoundException({ code: 'AGENT_NOT_FOUND', message });
      throw new BadRequestException({ code: 'AGENT_INVALID', message });
    }
  }

  /**
   * El catálogo de objetivos, para la pantalla que crea el asistente (#385).
   *
   * Va por el servidor y no como constante del frontend por el motivo de
   * siempre en este repo: una copia allá se desincroniza y nadie se entera
   * hasta que alguien elige un objetivo que ya no existe.
   *
   * `disponible` sale de los módulos ACTIVOS para este tenant. Un objetivo
   * que necesita agenda y el tenant no la tiene no se esconde: se muestra
   * bloqueado con el motivo, porque es lo que le dice al negocio qué le
   * falta. Bajar de plan nunca esconde (SPEC §6).
   */
  @Get('objetivos')
  @RequirePermission('agents.configure')
  @ApiOperation({ summary: 'Los objetivos que puede tener un asistente, y cuáles puede usar este negocio' })
  objetivos() {
    const activos = new Set(registry.health().filter((m) => m.active).map((m) => m.id));
    return OBJETIVOS.map((id) => {
      const d = DEFINICIONES[id];
      const faltan = d.requiere.filter((m) => !activos.has(m));
      return {
        id: d.id,
        titulo: d.titulo,
        // Con quién habla (#410). La pantalla agrupa por esto: "Vender" y
        // "Responder sobre los números" no son comparables y ofrecerlos en
        // la misma lista haría elegir mal.
        destinatario: d.destinatario,
        requiere: d.requiere,
        faltan,
        disponible: faltan.length === 0,
        datosMinimos: d.datosMinimos,
        detallePorDefecto: d.detallePorDefecto,
        // La instrucción NO se expone: es el prompt del sistema. Mostrarla
        // invita a editarla en la pantalla, y entonces deja de ser una
        // decisión del producto para volverse texto suelto por tenant.
        mide: d.eventoDeExito.length > 0,
      };
    });
  }

  /**
   * Qué puede hacer este asistente, para la pantalla que lo configura (#1285).
   *
   * Va por el servidor y no como constante del frontend, por el mismo motivo
   * que `GET agents/objetivos`: una copia allá se desincroniza y nadie se
   * entera hasta que alguien marca una casilla que ya no existe.
   *
   * Tres cosas que la pantalla no puede calcular sola:
   *
   *  - **`obligatoria`** — la exige el objetivo y no se puede quitar. Un
   *    asistente de `agendar` sin `calendar.get_slots` prometería horas que no
   *    puede ver.
   *  - **`disponible`** — su módulo está activo para este negocio. Lo que no
   *    está disponible NO se esconde: se muestra bloqueado con el motivo,
   *    porque es lo que le dice al negocio qué le falta (SPEC §6).
   *  - **el filtro por destinatario** — a un asistente que atiende clientes no
   *    se le ofrecen las cifras del negocio (#410). Sin esto, la pantalla
   *    reabriría por configuración el agujero que `atiendeClientes()` cerró.
   */
  @Get(':id/herramientas')
  @RequirePermission('agents.configure')
  @ApiOperation({ summary: 'Qué puede hacer este asistente, y qué más podría' })
  async herramientas(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    const agente = await withTenant(pool(), actor.tenantId, (c) =>
      getAgentContract(c, actor.tenantId, id),
    );
    const activos = new Set(registry.health().filter((m) => m.active).map((m) => m.id));
    // Sin objetivo atiende clientes, que es como funcionaban todos antes de
    // que el eje existiera (#410).
    const destinatario = agente.objetivo
      ? DEFINICIONES[agente.objetivo].destinatario
      : ('cliente' as const);
    const delObjetivo = new Set(
      agente.objetivo ? DEFINICIONES[agente.objetivo].tools : [],
    );
    const marcadas = new Set(agente.allowedTools);

    const todas = [
      ...Object.keys(HERRAMIENTAS_DE_LECTURA),
      ...Object.keys(HERRAMIENTAS_QUE_ESCRIBEN_HABILITADAS),
    ];
    return {
      destinatario,
      herramientas: todas
        .filter((nombre) => sirveParaEseAsistente(nombre, destinatario))
        .map((nombre) => {
          const d = CATALOGO_PARA_EL_DUENO[nombre];
          const modulo = nombre.split('.')[0];
          const disponible = activos.has(modulo);
          return {
            nombre,
            rotulo: d.rotulo,
            escribe: d.escribe,
            modulo,
            obligatoria: delObjetivo.has(nombre),
            marcada: marcadas.has(nombre) || delObjetivo.has(nombre),
            disponible,
            ...(disponible
              ? {}
              : { motivo: `Necesita el módulo de ${modulo}, que este negocio no tiene activo.` }),
          };
        }),
    };
  }

  @Get('usage')
  @RequirePermission('agents.use')
  @ApiOperation({ summary: 'Consumo de IA: asistencias para el equipo, pesos para el dueño' })
  async usage(@Req() request: WithUser) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      const quota = await getQuota(c, actor.tenantId);
      const settings = iaSettings(await getTenantSettings(c, actor.tenantId));
      const base = {
        used: quota.used,
        limit: quota.limit,
        pct: quota.pct,
        exhausted: quota.exhausted,
        economicoConfigurado: settings.economico !== null,
      };
      // El costo en PESOS es para quien supervisa el gasto (matriz §23).
      if (!actorCan(actor, 'agents.usage.read')) return base;
      const costUsd = await costThisCycle(c, actor.tenantId);
      // El MISMO tipo de cambio que la factura (#575).
      //
      // Esto leía `USD_CLP_RATE` por su cuenta y no conocía `BILLING_USD_CLP`:
      // con la segunda puesta y la primera sin poner, esta pantalla convertía a
      // 950 y la factura a otro número. Un tipo de cambio, dos lectores, dos
      // respuestas — y el cliente viendo un costo que no calza con lo que le
      // cobramos.
      const usdClp = usdClpRate();
      return {
        ...base,
        costUsdMonth: Number(costUsd.toFixed(4)),
        costClpMonth: Math.round(costUsd * usdClp),
        usdClpRate: usdClp,
        porDia: await costPerDay(c, actor.tenantId, 7),
      };
    });
  }

  @Get('executions')
  @RequirePermission('agents.usage.read')
  @ApiOperation({ summary: 'Corridas con tokens, costo, latencia y trace' })
  async executions(@Req() request: WithUser) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) => listExecutions(c, actor.tenantId));
  }

  @Post(':id/run')
  @RequirePermission('agents.use')
  @ApiOperation({ summary: 'Corre una tarea del asistente (mismo trace que el request)' })
  async run(
    @Req() request: WithUser,
    @Param('id') id: string,
    @Cuerpo(TareaDelAsistente) body: z.infer<typeof TareaDelAsistente>,
  ) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      const agent = await getAgent(c, actor.tenantId, id).catch(() => {
        throw new NotFoundException({ code: 'AGENT_NOT_FOUND', message: 'No encontramos ese asistente.' });
      });
      if (!agent.active) {
        throw new BadRequestException({ code: 'AGENT_OFF', message: 'Este asistente está apagado.' });
      }
      if (!providerAvailable(agent.provider as Provider)) {
        throw new ServiceUnavailableException({
          code: 'PROVIDER_UNAVAILABLE',
          message:
            'El proveedor de IA de este asistente aún no tiene llave configurada en este ambiente.',
        });
      }
      const res = await runAgentTask(c, {
        tenantId: actor.tenantId,
        agent,
        task: body.task,
        prompt: body.prompt,
        context: body.context,
        requestId: request.requestId,
        actorUserId: actor.userId,
        activeModules: registry
          .health()
          .filter((m) => m.active)
          .map((m) => m.id),
      });
      if (res.status === 'failed') {
        // `runAgentTask` no lanza: devuelve el texto crudo de quien falló.
        // Si ese texto es del proveedor, se traduce (#402) — llega en inglés
        // y con una URL de su panel, que no es un mensaje para el dueño de
        // una pyme. Si NO lo reconocemos como del proveedor, se respeta el
        // original: puede venir de una tool y perderlo sería peor.
        // Con quién falló (#677): `runAgentTask` devuelve `provider` y `model`
        // al lado del error y acá se estaban tirando. Desde #666 el asistente
        // puede caer a un proveedor distinto al que el negocio tiene elegido,
        // así que «el proveedor de IA» sin nombre puede señalar al equivocado.
        const d = motivoDelProveedor(res.error, {
          provider: res.provider,
          model: res.model,
          // De quién fue lo dice el runtime, que tenía el error en la mano (#684).
          // Clasificar por palabras acá convertía un permiso denegado en «el
          // proveedor rechazó la llave».
          delProveedor: res.errorDelProveedor === true,
        });
        if (d.motivo !== 'desconocido') {
          const cuerpo = { code: `PROVIDER_${d.motivo.toUpperCase()}`, message: d.message };
          if (d.reintentable) throw new ServiceUnavailableException(cuerpo);
          throw new ConflictException(cuerpo);
        }
        throw new BadRequestException({
          code: 'AGENT_RUN_FAILED',
          message: res.error ?? 'El asistente no pudo completar la tarea.',
        });
      }
      return res;
    });
  }

  /**
   * El dueño le pregunta por sus números (#410).
   *
   * Es OTRA puerta que `:id/run`, no un parámetro más, por tres razones que
   * no se pueden cumplir en la de allá:
   *
   *  1. Acá las herramientas SE EJECUTAN. `run` corre una sola pasada sin
   *     tools; el asistente de números sin tools no responde nada — inventa.
   *  2. La identidad que ejecuta es la de QUIEN PREGUNTA, no la del dueño de
   *     una conversación. Un vendedor que pregunta "cómo vamos" ve lo suyo,
   *     igual que en el tablero, porque el permiso lo resuelve la misma
   *     función (ADR-0008).
   *  3. Solo se ofrecen las herramientas del OBJETIVO, ni una más. Aunque el
   *     agente tuviera `crm.create_deal` habilitado de antes, por esta
   *     puerta no aparece: es un asistente que lee, y nada de lo que se
   *     escriba acá tendría a quién avisarle.
   */
  @Post(':id/preguntar')
  @RequirePermission('agents.use')
  @ApiOperation({ summary: 'Le pregunta al asistente del dueño (ejecuta herramientas de lectura)' })
  async preguntar(
    @Req() request: WithUser,
    @Param('id') id: string,
    @Cuerpo(PreguntaAlAsistente) body: z.infer<typeof PreguntaAlAsistente>,
  ) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      const agent = await getAgent(c, actor.tenantId, id).catch(() => {
        throw new NotFoundException({ code: 'AGENT_NOT_FOUND', message: 'No encontramos ese asistente.' });
      });
      const definicion = agent.objetivo ? DEFINICIONES[agent.objetivo] : undefined;
      if (definicion?.destinatario !== 'dueño') {
        throw new BadRequestException({
          code: 'AGENT_NO_ES_DEL_DUENO',
          message:
            'Este asistente está hecho para contestarle a tus clientes, no a ti. ' +
            'Crea uno de "Responder sobre los números" para preguntarle acá.',
        });
      }
      // El de configuración también es del dueño, pero su salida NO es una
      // respuesta: es una propuesta que se aplica o se descarta (#415). Una
      // respuesta suelta por acá sonaría a que algo quedó configurado.
      //
      // Va ANTES de mirar el proveedor a propósito: que este asistente no
      // conteste por esta puerta es lo que ES, no depende de si hay llave.
      // Un 503 acá mandaría a buscar una llave para una puerta que igual no
      // era la correcta.
      if (definicion.tools.length === 0) {
        throw new BadRequestException({
          code: 'AGENT_PROPONE_NO_RESPONDE',
          message:
            'Este asistente no responde preguntas: propone cómo configurar tu negocio, y tú ' +
            'decides si lo aplicas. Cuéntale de qué se trata en Ajustes → IA.',
        });
      }
      if (!agent.active) {
        throw new BadRequestException({ code: 'AGENT_OFF', message: 'Este asistente está apagado.' });
      }
      if (!providerAvailable(agent.provider as Provider)) {
        throw new ServiceUnavailableException({
          code: 'PROVIDER_UNAVAILABLE',
          message:
            'El proveedor de IA de este asistente aún no tiene llave configurada en este ambiente.',
        });
      }

      const activos = registry
        .health()
        .filter((m) => m.active)
        .map((m) => m.id);
      const objetivo = resolverObjetivo(agent.objetivo!, agent.objetivoDetalle, activos);
      if (!objetivo.alcanzable) {
        throw new BadRequestException({
          code: 'OBJETIVO_INALCANZABLE',
          message: `Para responder sobre los números falta ${objetivo.faltan.join(', ')} en este negocio.`,
        });
      }

      const tools = herramientasExpuestas(
        c,
        {
          tenantId: actor.tenantId,
          // Solo las del objetivo (ver el punto 3 de arriba).
          habilitadas: objetivo.tools,
          actorUserId: actor.userId ?? null,
          agentId: agent.id,
          requestId: request.requestId,
        },
        {
          // El MISMO traductor de permisos que el guard: lo que esta persona
          // no puede ver en el tablero, tampoco se lo cuenta la IA.
          actorPuede: (permiso) => actorCan(actor, permiso),
          habilitadas: objetivo.tools,
          // Las del cliente no se usan por esta puerta: no hay conversación,
          // no hay a quién responderle. Si alguna se pidiera igual, esto es
          // lo que el modelo recibe — un motivo, no una excepción.
          getContext: async () => {
            throw new Error('Acá no hay una conversación abierta.');
          },
          buscarConocimiento: async () => {
            throw new Error('Esta herramienta es para atender clientes.');
          },
          buscarProducto: async () => {
            throw new Error('Esta herramienta es para atender clientes.');
          },
          catalogoDeMetricas: async () => catalogoDeMetricas(),
          metricaDelNegocio: (i) => metricaEnRango(c, { tenantId: actor.tenantId, ...i }),
        },
      );

      const res = await runAgentTask(c, {
        tenantId: actor.tenantId,
        agent,
        task: 'analizar',
        // Llega sin espacios de sobra: el `.trim()` es parte del esquema.
        prompt: body.pregunta,
        tools,
        requestId: request.requestId,
        actorUserId: actor.userId,
        activeModules: activos,
      });
      if (res.status === 'failed') {
        throw new BadRequestException({
          code: 'AGENT_RUN_FAILED',
          message: res.error ?? 'El asistente no pudo responder.',
        });
      }
      return {
        texto: res.text,
        herramientasUsadas: res.herramientasUsadas ?? [],
        truncada: res.truncada === true,
        executionId: res.executionId,
      };
    });
  }

  // --- La evaluación (#53): ninguna versión empeora ---

  @Post(':id/evaluate')
  @RequirePermission('agents.configure')
  @ApiOperation({ summary: 'Corre el dataset del tenant contra la config actual' })
  async evaluate(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      const agente = await getAgent(c, actor.tenantId, id).catch(() => {
        throw new NotFoundException({ code: 'AGENT_NOT_FOUND', message: 'No encontramos ese asistente.' });
      });
      if (!providerAvailable(agente.provider as Provider)) {
        throw new ServiceUnavailableException({
          code: 'PROVIDER_UNAVAILABLE',
          message: 'El proveedor de IA aún no tiene llave configurada en este ambiente.',
        });
      }
      // El feedback fresco de la bandeja entra al dataset antes de correr.
      await harvestFeedbackCases(c, actor.tenantId);
      const cases = await listEvalCases(c, actor.tenantId);
      if (cases.length === 0) {
        throw new BadRequestException({
          code: 'NO_EVAL_CASES',
          message: 'Aún no hay casos: el pulgar arriba/abajo de la bandeja los va creando.',
        });
      }
      try {
        return await runEvaluation(c, {
          tenantId: actor.tenantId,
          agent: agente,
          cases,
          requestId: request.requestId,
        });
      } catch (err) {
        // Ningún caso se pudo medir: el modelo cortó todas las respuestas.
        // No es un score de 0 y no se guarda como tal — decirlo así evita
        // que el dueño lea "tu asistente sacó 0" cuando el problema es el
        // tope de tokens.
        if (/no hay medición/.test((err as Error).message)) {
          throw new ServiceUnavailableException({
            code: 'EVAL_NOT_MEASURABLE',
            message:
              'No pudimos evaluar: el modelo cortó todas las respuestas por falta de espacio. ' +
              'Prueba con casos de contexto más corto, o con un modelo que razone menos.',
          });
        }
        // Sin saldo, cuota agotada o llave vencida: se dice con nombre
        // (#402) en vez de caer en el genérico.
        const quien = { provider: agente.provider, model: agente.model };
        if (motivoDelProveedor(err, quien).motivo !== 'desconocido') comoExcepcionDelProveedor(err, quien);
        throw err;
      }
    });
  }

  @Get(':id/objetivo')
  @RequirePermission('agents.usage.read')
  @ApiOperation({ summary: 'Si el asistente está logrando su objetivo, y cuánto de eso es mérito suyo' })
  async objetivo(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) => tasaDeObjetivo(c, actor.tenantId, id));
  }

  /**
   * El respaldo de la tasa (#701).
   *
   * `achieved_event` y `closed_at` se escribían desde #319 y ningún `SELECT`
   * las devolvía, así que `/objetivo` era un porcentaje sin forma de revisarlo.
   * Esta ruta lo abre: qué evento contó como logro en cada caso, cuánto tardó,
   * y lo que llegó fuera de la ventana de atribución — que no suma a la tasa
   * pero explica por qué no contó.
   */
  @Get(':id/objetivo/intentos')
  @RequirePermission('agents.usage.read')
  @ApiOperation({ summary: 'Los intentos logrados con el evento que los logró, y los que llegaron tarde' })
  @ApiQuery({ name: 'limite', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } })
  async intentosDelObjetivo(
    @Req() request: WithUser,
    @Param('id') id: string,
    @Query('limite') limite?: string,
  ) {
    const actor = actorOf(request);
    const tope = Number(limite);
    return withTenant(pool(), actor.tenantId, async (c) => ({
      logrados: await intentosLogrados(c, actor.tenantId, id, Number.isFinite(tope) ? tope : 20),
      fueraDeVentana: await casiLogrados(c, actor.tenantId, id, Number.isFinite(tope) ? tope : 20),
      ventanaDias: VENTANA_ATRIBUCION_DIAS,
    }));
  }

  @Get(':id/evals')
  @RequirePermission('agents.usage.read')
  @ApiOperation({ summary: 'Las corridas de evaluación del asistente' })
  async evals(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) => listEvalRuns(c, actor.tenantId, id));
  }

  // --- El configurador (#50): propone un diff, el usuario decide ---

  @Get('configurador')
  @RequirePermission('agents.configure')
  @ApiOperation({ summary: 'La propuesta pendiente del configurador (si hay)' })
  async configuradorPendiente(@Req() request: WithUser) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) => pendingProposal(c, actor.tenantId));
  }

  /**
   * Quién va a armar la propuesta (#415).
   *
   * La pantalla lo muestra antes de que el dueño escriba nada. Antes de
   * esto, el configurador usaba "el asistente activo" sin decirlo: si el
   * negocio tenía uno de ventas con un modelo barato, la propuesta salía
   * con ese y no había forma de saberlo desde afuera.
   */
  @Get('configurador/quien')
  @RequirePermission('agents.configure')
  @ApiOperation({ summary: 'Qué asistente arma la propuesta de configuración' })
  async configuradorQuien(@Req() request: WithUser) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      const agente = await agenteQueConfigura(c, actor.tenantId);
      if (!agente) return { agente: null, propio: false };
      return {
        agente: { id: agente.id, name: agente.name, model: agente.model },
        // true si es uno hecho PARA esto, false si está prestado del que
        // atiende clientes.
        propio: agente.objetivo === 'configuracion',
      };
    });
  }

  @Post('configurador')
  @RequirePermission('agents.configure')
  @ApiOperation({ summary: 'Arma la propuesta del CRM a partir de la descripción del negocio' })
  async configuradorProponer(
    @Req() request: WithUser,
    @Cuerpo(DescripcionDelNegocio) body: z.infer<typeof DescripcionDelNegocio>,
  ) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      const agentes = await listAgents(c, actor.tenantId);
      const agente = agentes.find((a) => a.active);
      if (agente && !providerAvailable(agente.provider as Provider)) {
        throw new ServiceUnavailableException({
          code: 'PROVIDER_UNAVAILABLE',
          message:
            'El proveedor de IA de este asistente aún no tiene llave configurada en este ambiente.',
        });
      }
      const res = await proposeConfiguration(c, {
        activeModules: registry
          .health()
          .filter((m) => m.active)
          .map((m) => m.id),
        tenantId: actor.tenantId,
        description: body.description,
        vertical: body.vertical,
        actorUserId: actor.userId,
        requestId: request.requestId,
      });
      if (res.status === 'failed') {
        // Mismo criterio que la corrida (#402): si el fallo es del
        // proveedor se dice con nombre; si no, se respeta el original.
        // Acá NO se nombra (#677): el resultado del configurador no trae
        // `provider` ni `model`, y adivinarlos —poniendo el de los modelos por
        // omisión— sería peor que no decir nada: un nombre equivocado en un
        // mensaje de error manda a revisar la cuenta que no falló.
        if (motivoDelProveedor(res.error).motivo !== 'desconocido') comoExcepcionDelProveedor(res.error);
        throw new BadRequestException({ code: 'CONFIGURATOR_FAILED', message: res.error });
      }
      return res.proposal;
    });
  }

  @Post('configurador/:pid/aplicar')
  @RequirePermission('agents.configure')
  @ApiOperation({ summary: 'Aplica el diff con los permisos del usuario (user via agent)' })
  async configuradorAplicar(@Req() request: WithUser, @Param('pid') pid: string) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      try {
        return await applyProposal(c, {
          tenantId: actor.tenantId,
          proposalId: pid,
          actorUserId: actor.userId,
          requestId: request.requestId,
        });
      } catch (err) {
        throw new BadRequestException({ code: 'PROPOSAL_GONE', message: (err as Error).message });
      }
    });
  }

  @Post('configurador/:pid/descartar')
  @RequirePermission('agents.configure')
  @ApiOperation({ summary: 'Descarta la propuesta' })
  async configuradorDescartar(@Req() request: WithUser, @Param('pid') pid: string) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      try {
        await dismissProposal(c, { tenantId: actor.tenantId, proposalId: pid, actorUserId: actor.userId });
        return { dismissed: true };
      } catch (err) {
        throw new BadRequestException({ code: 'PROPOSAL_GONE', message: (err as Error).message });
      }
    });
  }
}
