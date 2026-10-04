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

/** El código HTTP del proveedor, venga como venga en el error. */
function estadoDe(error: unknown): number | null {
  const e = error as Record<string, unknown> | null;
  for (const campo of ['statusCode', 'status', 'code']) {
    const v = e?.[campo];
    if (typeof v === 'number' && v >= 100 && v < 600) return v;
  }
  // Algunos SDK anidan la respuesta.
  const anidado = (e?.response ?? e?.cause) as Record<string, unknown> | undefined;
  if (anidado) {
    for (const campo of ['statusCode', 'status']) {
      const v = anidado[campo];
      if (typeof v === 'number' && v >= 100 && v < 600) return v;
    }
  }
  return null;
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
  const texto = textoDe(error);
  const estado = estadoDe(error);

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

  if (/credits? (are )?depleted|prepayment|insufficient (balance|funds|credit)|billing/.test(texto)) {
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
