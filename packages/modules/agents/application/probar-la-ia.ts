import {
  PROVIDERS,
  TASKS,
  iaSettings,
  proveedorPermitidoParaTarea,
  type AgentTask,
  type Provider,
} from '../domain/config';
import {
  ENV_KEYS,
  aiSdkModelPort,
  providerAvailable,
  type ModelPortFactory,
} from './models';
import { motivoDelProveedor, type MotivoDelProveedor } from './motivo-del-proveedor';
import { castigar, estaCastigado, perdonar } from './castigados';

/**
 * «Probá la IA ahora y decime qué pasó» (#869).
 *
 * Lo que había antes respondía otra pregunta. `/ready` decía `ia ✓` si una
 * variable de entorno no estaba vacía; el diagnóstico decía qué proveedor tiene
 * asignada cada tarea; y `por-que-no-sugirio` explicaba una corrida PASADA, de a
 * una conversación. Ninguno de los tres le habla al proveedor.
 *
 * El resultado fue el peor posible: 51 corridas fallidas en tres semanas (#866)
 * con todo en verde. Un sistema cuyas verificaciones miran la configuración y no
 * la realidad no parece roto — parece vigilado, y eso es más difícil de
 * desarmar que una falla a secas.
 *
 * El dueño lo dijo así: «no puedes ver por qué demonios no funciona la IA
 * dentro, si es el núcleo y nunca he podido conversar con ella».
 *
 * El patrón existía al lado: `POST /v1/channels/{id}/probar-envio` manda un
 * mensaje de verdad con un texto fijo nuestro y te cuenta qué contestó Meta.
 * Esto es eso, para el núcleo.
 */

/**
 * El prompt de la prueba, fijo y nuestro.
 *
 * No lo elige quien prueba, por la misma razón que `CUERPO_DE_PRUEBA` en los
 * canales: una prueba tiene que ser comparable entre dos corridas y entre dos
 * proveedores. Y pide UNA palabra para que el gasto sea mínimo — aunque con los
 * modelos que razonan «una palabra» no significa pocos tokens, y por eso el
 * resultado informa cuántos se gastaron de verdad.
 */
export const PROMPT_DE_PRUEBA =
  'Esta es una prueba de conexión de IAxTi. Respondé exactamente la palabra: listo';

/** Lo que se le pide de salida. Corto, pero con aire para los que razonan. */
const TOPE_DE_PRUEBA = 600;

/** Y cuánto se le espera: una prueba que cuelga no diagnostica nada. */
const ESPERA_DE_PRUEBA_MS = 30_000;

/** Quiénes saben hacer esta tarea, con llave o sin ella. Es capacidad. */
const proveedoresQuePueden = (tarea: AgentTask): Provider[] =>
  PROVIDERS.filter((p) => proveedorPermitidoParaTarea(p, tarea));

/** Si hay otro con credencial al que mandar a quien lee. */
const hayOtroQuePueda = (tarea: AgentTask, hayLlave: (p: Provider) => boolean): boolean =>
  proveedoresQuePueden(tarea).some((p) => hayLlave(p));

export interface ResultadoDeLaPrueba {
  /** Si el proveedor contestó. Es LA pregunta, y antes no se podía hacer. */
  contesto: boolean;
  /** La tarea que se probó. */
  tarea: AgentTask;
  /**
   * El proveedor y modelo que se usaron DE VERDAD, con el respaldo de #665 ya
   * aplicado. No los escritos: si el respaldo eligió otro, eso es lo que hay
   * que probar, y `pedido` cuenta cuál se había pedido.
   */
  proveedor: Provider;
  modelo: string;
  /**
   * El proveedor que la configuración pedía, cuando NO es el que se usó.
   *
   * Esta es la línea que habría ahorrado la noche del 11-10: el negocio tenía
   * GLM por defecto, GLM no tenía llave en el contenedor, y el respaldo cayó a
   * google —sin saldo— sin que ninguna pantalla lo dijera.
   */
  pedido: Provider | null;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  /** El texto que volvió, recortado. Vacío no es lo mismo que un error. */
  texto: string;
  /** Si falló, el motivo ya clasificado. Nunca el texto crudo del proveedor. */
  motivo: MotivoDelProveedor | null;
  /** Qué pasó y qué hacer, en una frase, con la voz del producto. */
  mensaje: string;
}

/**
 * Hace UNA llamada real y cuenta qué pasó.
 *
 * Pura respecto del ambiente en lo que importa: `hayLlave` y la fábrica del
 * modelo entran por parámetro, así que el caso «tiene credencial y no tiene
 * saldo» —el que costó tres semanas— se puede probar sin una cuenta sin saldo.
 */
export async function probarLaIa(
  entrada: {
    tarea?: AgentTask;
    settings: Record<string, unknown> | null | undefined;
  },
  deps: {
    modelPortFactory?: ModelPortFactory;
    hayLlave?: (p: Provider) => boolean;
    ahora?: () => number;
  } = {},
): Promise<ResultadoDeLaPrueba> {
  const hayLlave = deps.hayLlave ?? providerAvailable;
  const fabrica = deps.modelPortFactory ?? aiSdkModelPort;
  const ahora = deps.ahora ?? (() => Date.now());

  // `sugerir` por defecto: es la que un negocio usa todo el día, así que es la
  // que importa que funcione.
  const tarea: AgentTask = entrada.tarea && TASKS.includes(entrada.tarea) ? entrada.tarea : 'sugerir';

  const efectiva = iaSettings(entrada.settings, hayLlave, estaCastigado).tasks[tarea];
  const escrita = iaSettings(entrada.settings).tasks[tarea];
  const pedido = escrita.provider !== efectiva.provider ? escrita.provider : null;

  // Sin llave no hay a quién preguntarle, y gastar una llamada para
  // descubrirlo sería absurdo. Se responde con la misma forma que un fallo del
  // proveedor, porque para quien lee es el mismo problema: la IA no trabaja.
  if (!hayLlave(efectiva.provider)) {
    return {
      contesto: false,
      tarea,
      proveedor: efectiva.provider,
      modelo: efectiva.model,
      pedido,
      latencyMs: 0,
      tokensIn: 0,
      tokensOut: 0,
      texto: '',
      motivo: 'sin_llave',
      /**
       * El consejo depende de si hay otro proveedor QUE PUEDA, y por eso se
       * mira antes de darlo.
       *
       * La primera versión decía siempre «elige otro en los ajustes de IA», y
       * la corrida dentro del contenedor lo mostró mintiendo justo en
       * `transcribir`: ahí no hay otro: el audio entra como file part y los
       * endpoints de texto no lo reciben (#864). Mandar a alguien a elegir
       * entre una lista de uno es la clase de consejo que gasta una tarde — el
       * mismo defecto que esta función vino a sacar, cometido por ella.
       */
      mensaje: hayOtroQuePueda(tarea, hayLlave)
        ? `El proveedor de "${tarea}" (${efectiva.provider}) no tiene credencial en este ` +
          `ambiente. Configura ${ENV_KEYS[efectiva.provider]}, o elige otro proveedor para esa ` +
          'tarea en los ajustes de IA.'
        : `Ningún proveedor de este ambiente puede atender "${tarea}", y no hay otro para ` +
          `elegir: solo ${proveedoresQuePueden(tarea).join(' y ')} saben hacerla. Configura ` +
          `${ENV_KEYS[efectiva.provider]} en el ambiente.`,
    };
  }

  const t0 = ahora();
  try {
    const puerto = fabrica(efectiva.provider, efectiva.model);
    const res = await puerto.generate({
      system: 'Respondé exactamente lo que se te pide, sin agregar nada.',
      prompt: PROMPT_DE_PRUEBA,
      maxOutputTokens: TOPE_DE_PRUEBA,
      esperaMaximaMs: ESPERA_DE_PRUEBA_MS,
    });
    const latencyMs = ahora() - t0;
    const texto = res.text.trim();

    /**
     * Texto vacío con la llamada OK: el caso que los modelos que razonan
     * trajeron (#859).
     *
     * `z-ai/glm-5.3-flash` con el tope chico devuelve `content: null` y
     * `finish_reason: "length"` — gastó el presupuesto pensando y no escribió
     * nada. HTTP 200, cero texto. Contar eso como «contestó» sería exactamente
     * el defecto que esta función viene a sacar: una verificación que pasa
     * mientras la función no sirve.
     */
    if (texto === '') {
      return {
        contesto: false,
        tarea,
        proveedor: efectiva.provider,
        modelo: efectiva.model,
        pedido,
        latencyMs,
        tokensIn: res.tokensIn,
        tokensOut: res.tokensOut,
        texto: '',
        motivo: 'desconocido',
        mensaje:
          `${efectiva.provider}/${efectiva.model} respondió sin texto` +
          (res.truncada ? ' y la respuesta venía cortada' : '') +
          `, gastando ${res.tokensOut} tokens de salida. ` +
          'Suele ser un modelo que razona con poco espacio para escribir: sube el tope de salida ' +
          'de esa tarea o usa un modelo que razone menos.',
      };
    }

    /**
     * Contestó: se le levanta el castigo de #855.
     *
     * Y acá importa más que en ningún otro lado: este botón es justo el que
     * alguien aprieta después de cargar crédito, para comprobar que volvió.
     * Si la prueba dijera «contesta» y el producto siguiera saltándolo por un
     * castigo de hace tres minutos, la herramienta de diagnóstico estaría
     * contradiciendo al producto — que es exactamente lo que vino a arreglar.
     */
    perdonar(efectiva.provider);

    return {
      contesto: true,
      tarea,
      proveedor: efectiva.provider,
      modelo: efectiva.model,
      pedido,
      latencyMs,
      tokensIn: res.tokensIn,
      tokensOut: res.tokensOut,
      texto: texto.slice(0, 200),
      motivo: null,
      mensaje:
        `${efectiva.provider}/${efectiva.model} contestó en ${latencyMs} ms` +
        (pedido ? `. Ojo: la configuración pedía ${pedido}, que no tiene credencial acá` : '') +
        '.',
    };
  } catch (err) {
    const latencyMs = ahora() - t0;
    // La clasificación ya existe y ya sabe decir «sin saldo» distinto de «la
    // llave no sirve». Lo que faltaba era alguien que la invocara a propósito
    // en vez de solo al pasar, cuando un usuario ya se quedó sin respuesta.
    const d = motivoDelProveedor(err, { provider: efectiva.provider, model: efectiva.model });
    // Y si falló por algo que no se arregla reintentando, se lo aparta: una
    // prueba a mano es una llamada real, así que vale como evidencia.
    castigar(efectiva.provider, d.motivo);
    return {
      contesto: false,
      tarea,
      proveedor: efectiva.provider,
      modelo: efectiva.model,
      pedido,
      latencyMs,
      tokensIn: 0,
      tokensOut: 0,
      texto: '',
      motivo: d.motivo,
      mensaje: d.message,
    };
  }
}
