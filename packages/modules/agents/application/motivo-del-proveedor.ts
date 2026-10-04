import { esDelProveedor, estadoDelProveedor } from './fallo-del-proveedor';
/**
 * Por qué NO contestó el proveedor de IA (#402).
 *
 * El producto distinguía una sola forma de que el proveedor fallara: que no
 * hubiera llave. Todo lo demás —sin saldo, cuota agotada, llave vencida—
 * caía en el genérico:
 *
 *   "Algo falló de nuestro lado. Ya quedó registrado; intenta de nuevo en
 *    un momento."
 *
 * Que es justo lo que la regla de mensajes prohíbe: no dice qué pasó ni qué
 * hacer. Y peor, dice "de nuestro lado" cuando el lado es del cliente.
 *
 * Apareció de verdad: Lino cargó su llave de Gemini y recibió
 * `402 RESOURCE_EXHAUSTED · Your prepayment credits are depleted`. Eso no se
 * arregla reintentando: hay que cargar crédito. El dueño tiene que poder
 * leerlo sin abrir Sentry.
 */

export type MotivoDelProveedor =
  | 'sin_llave'
  | 'no_contesto_a_tiempo'
  | 'sin_saldo'
  | 'cuota_agotada'
  | 'llave_invalida'
  | 'modelo_no_disponible'
  | 'desconocido';

/**
 * Con quién falló, cuando quien arma el mensaje lo sabe (#677).
 *
 * Es opcional a propósito: hay call sites que solo tienen el error en la mano y
 * tienen que seguir funcionando igual. Los que sí lo saben —el asistente y el
 * agente general, que reciben `provider` y `model` al lado del error— lo pasan.
 */
export interface QuienFallo {
  provider?: string | null;
  model?: string | null;
  /**
   * Si consta que el error vino del proveedor (#684).
   *
   * Sin esto solo se clasifica lo que trae la marca que pone el puerto del
   * modelo. Lo necesita el camino que lee de `agent_executions`: ahí el error es
   * una columna de texto y la marca no sobrevive a la base, así que quien lee la
   * fila tiene que decir lo que la fila sabe.
   *
   * `false` y `undefined` no son lo mismo: `false` es «consta que NO», y
   * `undefined` es «no se sabe». No saberlo también impide afirmar.
   */
  delProveedor?: boolean;
}

export interface DiagnosticoDelProveedor {
  motivo: MotivoDelProveedor;
  /** Qué pasó y qué hacer, en una frase. Nunca incluye la llave ni la URL. */
  message: string;
  /**
   * Si reintentar tiene sentido. Sin saldo NO es reintentable, y decir
   * "intenta de nuevo" ahí le hace perder el tiempo al dueño.
   */
  reintentable: boolean;
}


/**
 * Le pega al mensaje con quién falló.
 *
 * Suena a detalle y es lo contrario. Hasta #666, «el proveedor de IA» era una
 * frase segura porque había uno: el que el negocio tenía elegido. Desde ese
 * arreglo, un asistente cuyo proveedor no tiene credencial cae al que sí la
 * tenga —que es lo que hizo que la IA volviera a contestar— y entonces «el
 * proveedor» puede no ser el que quien lee el mensaje cree que está usando.
 *
 * El 27/09 costó una hora: el producto dijo «falta saldo» mientras la llave que
 * estaba puesta contestaba 200. Con el nombre, esa hora son diez segundos.
 *
 * El nombre del proveedor y del modelo, nada más. Nunca la llave ni un pedazo.
 */
function conQuien(base: string, quien?: QuienFallo): string {
  const proveedor = quien?.provider?.trim();
  if (!proveedor) return base;
  const modelo = quien?.model?.trim();
  return `${base} El que falló fue ${proveedor}${modelo ? ` con el modelo ${modelo}` : ''}.`;
}

function textoDe(error: unknown): string {
  const e = error as Record<string, unknown> | null;
  const partes = [
    typeof e?.message === 'string' ? e.message : '',
    typeof e?.responseBody === 'string' ? e.responseBody : '',
  ];
  return partes.join(' ').toLowerCase();
}

/**
 * Traduce el fallo del proveedor a un motivo con nombre.
 *
 * Mira el TEXTO antes que el código porque los proveedores no se ponen de
 * acuerdo: Gemini devuelve `402` con `RESOURCE_EXHAUSTED` para "sin saldo" y
 * `429` con el mismo `RESOURCE_EXHAUSTED` para "cuota por minuto". Por
 * código solo, las dos se leerían igual, y una se arregla esperando y la
 * otra pagando.
 */
export function motivoDelProveedor(error: unknown, quien?: QuienFallo): DiagnosticoDelProveedor {
  // De quién es el error, ANTES de mirar su texto (#684).
  //
  // Éste es el arreglo, y es una línea. Esta función traduce el error DEL
  // PROVEEDOR y se estaba usando como clasificador de errores en general: un
  // permiso denegado salía como «el proveedor rechazó la llave», un contacto que
  // no existe como «el modelo ya no está disponible», y cualquier cosa que
  // mencionara `billing` —un módulo, una ruta y un permiso NUESTROS, presentes en
  // las 195 herramientas del agente general— como «tu proveedor se quedó sin
  // saldo».
  //
  // Con una instrucción concreta encima: «carga crédito en su panel». Mandaba a
  // arreglar una cuenta sana mientras el problema real quedaba invisible, y se
  // fueron horas de madrugada en eso con la llave contestando 200.
  //
  // Quien no puede probar que el error es del proveedor, no afirma que lo sea.
  if (!(quien?.delProveedor ?? esDelProveedor(error))) {
    return {
      motivo: 'desconocido',
      message: conQuien(
        'No pudimos completar esto. Quedó registrado con su identificador; si sigue pasando, ' +
          'míralo en las corridas del asistente.',
        quien,
      ),
      // Sin saber de quién fue, reintentar es lo razonable. Lo que no se hace es
      // inventar una causa para poder sonar seguro.
      reintentable: true,
    };
  }

  const texto = textoDe(error);
  const estado = estadoDelProveedor(error);

  if (/no tiene llave configurada/.test(texto)) {
    return {
      motivo: 'sin_llave',
      message: conQuien(
        'El proveedor de IA de este asistente aún no tiene llave configurada en este ambiente.',
        quien,
      ),
      reintentable: false,
    };
  }

  // El reloj se venció (#688). Va PRIMERO porque un abort trae textos que
  // parecen de otra cosa —«terminated», «aborted», a veces un código de red— y
  // clasificarlo como «el proveedor está caído» mandaría a revisar su estado
  // cuando lo que pasó es que tardó demasiado.
  if (/aborted|abort|timeouterror|the operation was aborted|timed? ?out/i.test(texto)) {
    return {
      motivo: 'no_contesto_a_tiempo',
      message: conQuien(
        'El proveedor de IA no contestó a tiempo y cortamos la espera. Suele ser congestión ' +
          'suya —no es un problema de tu cuenta ni de tu llave—: vuelve a intentar en un rato.',
        quien,
      ),
      // Reintentable: la congestión pasa. Y decirlo importa, porque el mensaje
      // de al lado —«sin saldo»— pide exactamente lo contrario.
      reintentable: true,
    };
  }

  // `billing` a secas NO (#684): es un módulo, una ruta y un permiso nuestros. Si
  // un proveedor habla de facturación se lo reconoce por una frase suya —OpenAI
  // dice «check your plan and billing details»— y no por una palabra que además
  // usamos en 195 herramientas.
  if (
    /credits? (are )?depleted|prepayment|insufficient (balance|funds|credit)|billing (details|issue|problem)|plan and billing|add (a )?payment method|payment required/.test(
      texto,
    )
  ) {
    return {
      motivo: 'sin_saldo',
      message: conQuien(
        'Tu proveedor de IA se quedó sin saldo. Carga crédito en su panel y el asistente vuelve solo; ' +
          'no hace falta tocar nada acá.',
        quien,
      ),
      reintentable: false,
    };
  }

  if (estado === 429 || /rate.?limit|quota|too many requests/.test(texto)) {
    return {
      motivo: 'cuota_agotada',
      message: conQuien(
        'El proveedor de IA está limitando por cuota. Espera un momento y vuelve a intentar; ' +
          'si pasa seguido, revisa el plan que tienes con ellos.',
        quien,
      ),
      reintentable: true,
    };
  }

  if (estado === 401 || estado === 403 || /api key|unauthorized|permission denied|invalid.*credential/.test(texto)) {
    return {
      motivo: 'llave_invalida',
      message: conQuien(
        'La llave del proveedor de IA no es válida o venció. Genera una nueva en su panel y cárgala de nuevo.',
        quien,
      ),
      reintentable: false,
    };
  }

  if (estado === 404 || /model.*not found|is not supported|unknown model/.test(texto)) {
    return {
      motivo: 'modelo_no_disponible',
      message: conQuien(
        'El modelo configurado para este asistente ya no está disponible en el proveedor. ' +
          'Elige otro en la configuración del asistente.',
        quien,
      ),
      reintentable: false,
    };
  }

  return {
    motivo: 'desconocido',
    message: conQuien(
      'El proveedor de IA no pudo responder. Quedó registrado; si sigue pasando, revisa su estado.',
      quien,
    ),
    // Un fallo que no supimos nombrar suele ser de red: reintentar es lo
    // razonable. Lo que no se hace es prometer que se va a arreglar.
    reintentable: true,
  };
}
