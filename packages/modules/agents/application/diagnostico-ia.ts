import { PROVIDERS, TASKS, iaSettings, type AgentTask, type Provider } from '../domain/config';
import { ENV_KEYS, providerAvailable } from './models';

/**
 * ¿Por qué la IA no hace nada? (#614)
 *
 * El canal tiene un diagnóstico de siete pasos desde #526 y ha servido cada vez
 * que algo no salía. La IA no tenía nada: si falta una llave, `languageModel`
 * lanza, el error sube como un 500 genérico —«Algo falló de nuestro lado»— y
 * quien mira la pantalla no tiene forma de saber que el problema es una variable
 * de entorno ausente.
 *
 * Eso es lo que hace que alguien diga «nunca pude probar nada»: no es que no
 * funcione, es que no se puede ver POR QUÉ no funciona. Y un producto que no
 * puede explicarse obliga a que alguien con acceso al servidor lo explique.
 *
 * Lo que este diagnóstico NO hace, y es deliberado: **no muestra ni un pedazo de
 * ninguna llave.** Solo si la variable existe. Es la misma regla que el paso de
 * la credencial del canal, y por el mismo motivo: un diagnóstico es una pantalla
 * que alguien va a compartir por WhatsApp para pedir ayuda.
 *
 * Tampoco llama al proveedor. Comprobar que la llave SIRVE es otra cosa —cuesta
 * plata y tiempo— y va en su propia acción, como el «probar el envío» del canal.
 * Acá se responde la pregunta barata, que es la que falla el 90 % de las veces.
 */

export type EstadoDelPaso = 'bien' | 'mal' | 'atencion' | 'desconocido';

export interface PasoDeLaIa {
  id: string;
  titulo: string;
  estado: EstadoDelPaso;
  detalle: string;
  queHacer?: string;
}

export interface DiagnosticoDeLaIa {
  /** El primer paso que está mal. `null` si la IA puede trabajar. */
  problema: string | null;
  pasos: PasoDeLaIa[];
}

/** Cómo se llama cada tarea para alguien que no escribió el código. */
const EN_CASTELLANO: Record<AgentTask, string> = {
  clasificar: 'entender de qué se trata un mensaje',
  sugerir: 'proponerle una respuesta a quien atiende',
  responder: 'contestarle solo a un cliente',
  configurar: 'configurar el producto conversando',
  conocer: 'buscar en el conocimiento del negocio',
  resumir: 'resumir una conversación',
  transcribir: 'entender un audio que mandó un cliente',
  analizar: 'contestarle al dueño sobre sus números',
  configuracion_conversada: 'el Agente General',
} as Record<AgentTask, string>;

export function diagnosticarLaIa(input: {
  settings: Record<string, unknown> | null | undefined;
  /** Para no depender del entorno en las pruebas. */
  hayLlave?: (provider: Provider) => boolean;
}): DiagnosticoDeLaIa {
  const hayLlave = input.hayLlave ?? providerAvailable;
  const ia = iaSettings(input.settings);
  const pasos: PasoDeLaIa[] = [];

  // 1. Lo primero, porque si no hay ninguna llave nada más importa.
  const conLlave = PROVIDERS.filter((p) => hayLlave(p));
  const sinLlave = PROVIDERS.filter((p) => !hayLlave(p));
  pasos.push({
    id: 'proveedores',
    titulo: 'Proveedores de IA disponibles',
    estado: conLlave.length > 0 ? 'bien' : 'mal',
    detalle:
      conLlave.length > 0
        ? `Hay ${conLlave.length} de ${PROVIDERS.length} con credencial: ${conLlave.join(', ')}.`
        : 'Ninguno tiene credencial configurada, así que la IA no puede hacer nada.',
    ...(conLlave.length === 0
      ? {
          // Se nombra la VARIABLE, nunca el valor: quien opera el ambiente
          // necesita saber qué poner y dónde.
          queHacer:
            'Configura al menos una en el ambiente: ' +
            PROVIDERS.map((p) => ENV_KEYS[p]).join(', ') +
            '. Sin eso, todo lo que dependa de la IA falla con un error genérico.',
        }
      : sinLlave.length > 0
        ? {
            // Con la VARIABLE de cada uno, no solo el nombre del proveedor: la
            // variable es lo único accionable, y una prueba me lo hizo notar
            // justo acá — el mensaje nombraba los proveedores y dejaba a quien
            // lo lee buscando cuál variable era.
            queHacer:
              'Sin credencial: ' +
              sinLlave.map((p) => `${p} (${ENV_KEYS[p]})`).join(', ') +
              '. No hace falta tenerlos todos, pero un negocio que pida uno de esos por ' +
              'escrito no va a poder elegirlo.',
          }
        : {}),
  });

  // 2. Lo que el negocio PIDIÓ tiene prioridad sobre lo que hay.
  if (ia.soloProveedor) {
    const disponible = hayLlave(ia.soloProveedor);
    pasos.push({
      id: 'proveedor_exigido',
      titulo: 'El proveedor que este negocio exige',
      estado: disponible ? 'bien' : 'mal',
      detalle: disponible
        ? `Este negocio pidió usar solo ${ia.soloProveedor}, y está disponible.`
        : `Este negocio pidió usar solo ${ia.soloProveedor} y NO tiene credencial configurada.`,
      ...(disponible
        ? {}
        : {
            // Este caso es peor que no tener IA: hay un compromiso escrito con
            // el cliente y el producto no lo puede cumplir ni avisar.
            queHacer:
              `Configura ${ENV_KEYS[ia.soloProveedor]}, o habla con el negocio antes de ` +
              'usar otro proveedor: pidió ese por escrito y sus datos no pueden pasar por otro.',
          }),
    });
  }

  // 3. Tarea por tarea, en castellano. Es lo que alguien viene a buscar cuando
  //    dice «la sugerencia no aparece».
  const rotas = TASKS.filter((t) => !hayLlave(ia.tasks[t].provider));
  pasos.push({
    id: 'tareas',
    titulo: 'Qué puede hacer la IA hoy',
    estado: rotas.length === 0 ? 'bien' : rotas.length === TASKS.length ? 'mal' : 'atencion',
    detalle:
      rotas.length === 0
        ? `Las ${TASKS.length} tareas tienen un proveedor con credencial.`
        : `${rotas.length} de ${TASKS.length} no pueden funcionar: ` +
          rotas.map((t) => EN_CASTELLANO[t] ?? t).join('; ') + '.',
    ...(rotas.length === 0
      ? {}
      : {
          queHacer:
            'Cada una usa el proveedor que tiene asignado. Configura su credencial, o cambia ' +
            'el proveedor de esa tarea en los ajustes de IA.',
        }),
  });

  // 4. ¿A qué proveedor apunta lo que el negocio TIENE GUARDADO? (#665)
  //
  // Los tres pasos de arriba miran la configuración efectiva, que desde #665 ya
  // cae a un proveedor con credencial. Este mira lo GUARDADO, que es lo que
  // alguien eligió alguna vez — y es donde estuvo el problema: los ajustes
  // apuntaban a un proveedor de antes de que ADR-0025 moviera el texto a GLM, el
  // ambiente tenía GLM, y este diagnóstico decía que todo estaba bien mientras
  // la IA no contestaba nunca.
  //
  // Ya no impide trabajar —por eso es 'atencion' y no 'mal'—, pero se dice:
  // alguien eligió un proveedor y está usando otro, y enterarse por una pantalla
  // es mejor que no enterarse.
  const guardados = TASKS.filter((t) => {
    const g = (input.settings as { ia?: { tasks?: Record<string, { provider?: string }> } })?.ia
      ?.tasks?.[t]?.provider;
    return g && PROVIDERS.includes(g as Provider) && !hayLlave(g as Provider);
  });
  if (guardados.length > 0) {
    pasos.push({
      id: 'proveedor_guardado',
      titulo: 'Lo que este negocio tenía elegido',
      estado: 'atencion',
      detalle:
        `${guardados.length} ${guardados.length === 1 ? 'tarea tiene' : 'tareas tienen'} ` +
        'elegido a mano un proveedor que este ambiente no tiene: ' +
        guardados.map((t) => EN_CASTELLANO[t] ?? t).join('; ') + '.',
      queHacer:
        'Se están atendiendo con un proveedor que sí tiene credencial, así que la IA ' +
        'funciona. Si la elección era a propósito, configura su credencial; si no, ' +
        'vuelve a elegir el proveedor en los ajustes de IA para que quede escrito lo ' +
        'que de verdad está pasando.',
    });
  }

  const roto = pasos.find((p) => p.estado === 'mal');
  return { problema: roto?.id ?? null, pasos };
}
