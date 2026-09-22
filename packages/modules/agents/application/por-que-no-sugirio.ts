import type { PoolClient } from 'pg';
import { providerAvailable } from './models';
import { PROVIDERS, type Provider } from '../domain/config';
import { activeAgent } from './copilot';
import { motivoDelProveedor } from './motivo-del-proveedor';

/**
 * Por qué esta conversación no tiene sugerencia (#436).
 *
 * El copiloto se salta el trabajo en varios casos legítimos —sin llave del
 * proveedor, sin asistente que atienda, el modelo no respondió— y el motivo
 * se devolvía en el resultado del job, que no mira nadie. Desde la bandeja,
 * las cinco causas se ven igual: el panel de sugerencia vacío.
 *
 * Es el mismo agujero que el de los canales (#434) un piso más arriba, y la
 * misma respuesta: no adivinar, mirar lo que quedó registrado.
 *
 * Se responde a PEDIDO, no en cada mensaje: es una pregunta que se hace
 * cuando falta algo, y hacerla siempre sería una consulta más por cada
 * entrante de cada negocio.
 */
export type CodigoSinSugerencia =
  | 'sin_llave'
  | 'sin_asistente'
  | 'asistente_apagado'
  | 'sin_saldo'
  | 'cuota_agotada'
  | 'llave_invalida'
  | 'modelo_no_disponible'
  | 'respuesta_cortada'
  | 'no_se_entendio'
  | 'todavia_trabajando';

export interface SinSugerencia {
  codigo: CodigoSinSugerencia;
  /** Qué pasó, en una línea, para quien atiende. */
  texto: string;
  /** Qué hacer. Vacío cuando no hay nada que hacer más que esperar. */
  queHacer?: string;
  /** true si lo arregla el dueño del negocio; false si es cosa nuestra. */
  loArreglaElNegocio: boolean;
}

const CATALOGO: Record<CodigoSinSugerencia, Omit<SinSugerencia, 'codigo'>> = {
  sin_llave: {
    texto: 'Este ambiente no tiene configurada ninguna llave de IA.',
    queHacer: 'Es cosa nuestra: falta la llave del proveedor en el despliegue.',
    loArreglaElNegocio: false,
  },
  sin_asistente: {
    texto: 'No hay ningún asistente que atienda conversaciones.',
    queHacer: 'Crea tu asistente en Ajustes → IA y elige qué tiene que lograr.',
    loArreglaElNegocio: true,
  },
  asistente_apagado: {
    texto: 'Tu asistente está apagado.',
    queHacer: 'Enciéndelo en Ajustes → IA cuando quieras que vuelva a sugerir.',
    loArreglaElNegocio: true,
  },
  sin_saldo: {
    texto: 'El proveedor de IA rechazó la petición por falta de saldo.',
    queHacer: 'Es cosa nuestra: hay que recargar la cuenta del proveedor.',
    loArreglaElNegocio: false,
  },
  cuota_agotada: {
    texto: 'Se agotó la cuota de IA de este mes.',
    queHacer: 'Puedes subir el límite en Ajustes → IA, o esperar al próximo ciclo.',
    loArreglaElNegocio: true,
  },
  llave_invalida: {
    texto: 'El proveedor rechazó la llave configurada.',
    queHacer: 'Es cosa nuestra: la llave del proveedor no sirve o fue revocada.',
    loArreglaElNegocio: false,
  },
  modelo_no_disponible: {
    texto: 'El modelo configurado ya no está disponible.',
    queHacer: 'Elige otro modelo en Ajustes → IA.',
    loArreglaElNegocio: true,
  },
  respuesta_cortada: {
    texto: 'La respuesta del modelo quedó cortada y no se puede usar a medias.',
    queHacer: 'Suele pasar con conversaciones muy largas. La próxima entrada vuelve a intentarlo.',
    loArreglaElNegocio: false,
  },
  no_se_entendio: {
    texto: 'El modelo respondió algo que no se pudo leer como sugerencia.',
    queHacer: 'La próxima entrada vuelve a intentarlo. Si se repite, avísanos.',
    loArreglaElNegocio: false,
  },
  todavia_trabajando: {
    // No es un problema: el copiloto corre DESPUÉS del camino de entrada,
    // a propósito, para que la bandeja nunca espere a la IA.
    texto: 'El asistente todavía está trabajando en esta conversación.',
    loArreglaElNegocio: false,
  },
};

export function describirSinSugerencia(codigo: CodigoSinSugerencia): SinSugerencia {
  return { codigo, ...CATALOGO[codigo] };
}

/**
 * La respuesta, mirando lo registrado y en el orden en que importa.
 *
 * De afuera hacia adentro, igual que el diagnóstico de canal: si no hay
 * llave, que además falte el asistente no cambia nada — y dos problemas a
 * la vez hacen que no se arregle ninguno.
 */
export async function porQueNoHaySugerencia(
  client: PoolClient,
  input: { tenantId: string; conversationId: string; desde?: Date },
  deps: {
    /**
     * ¿Hay alguna llave de proveedor en este ambiente?
     *
     * Inyectable para poder probar el caso sin tocar `process.env`: esa
     * variable es del PROCESO y vitest corre los archivos en hilos que lo
     * comparten, así que un test que la borra se la borra a los que corren
     * al lado. Ya pasó una vez y costó creer que no era la máquina.
     */
    hayLlave?: () => boolean;
  } = {},
): Promise<SinSugerencia> {
  const hayLlave = deps.hayLlave ?? (() => PROVIDERS.some((p: Provider) => providerAvailable(p)));
  if (!hayLlave()) {
    return describirSinSugerencia('sin_llave');
  }

  const agente = await activeAgent(client, input.tenantId);
  if (!agente) {
    // Se distingue "no hay ninguno" de "el que hay está apagado": son dos
    // arreglos distintos y el segundo es un interruptor.
    const hay = await client.query(
      `SELECT 1 FROM agents WHERE tenant_id = $1 AND (objetivo IS NULL OR objetivo <> 'estadisticas') LIMIT 1`,
      [input.tenantId],
    );
    return describirSinSugerencia((hay.rowCount ?? 0) > 0 ? 'asistente_apagado' : 'sin_asistente');
  }

  // La última corrida de sugerencia de este negocio. No hay columna de
  // conversación en las ejecuciones, así que se acota por TIEMPO: lo que
  // pasó en los últimos minutos es lo que explica esta conversación.
  const desde = input.desde ?? new Date(Date.now() - 15 * 60_000);
  const ultima = await client.query(
    `SELECT status, error, output, created_at
       FROM agent_executions
      WHERE tenant_id = $1 AND task = 'sugerir' AND created_at >= $2
      ORDER BY created_at DESC LIMIT 1`,
    [input.tenantId, desde],
  );
  if (ultima.rowCount === 0) {
    // Nada corrió: el copiloto vive en una cola y corre después del camino
    // de entrada, así que lo normal es que todavía esté en eso.
    return describirSinSugerencia('todavia_trabajando');
  }

  const fila = ultima.rows[0] as { status: string; error: string | null; output: unknown };
  const salida = (fila.output ?? {}) as { text?: string | null; truncada?: boolean };
  if (fila.error) {
    const diagnostico = motivoDelProveedor(new Error(fila.error));
    const codigo: CodigoSinSugerencia =
      diagnostico.motivo === 'sin_saldo'
        ? 'sin_saldo'
        : diagnostico.motivo === 'cuota_agotada'
          ? 'cuota_agotada'
          : diagnostico.motivo === 'llave_invalida' || diagnostico.motivo === 'sin_llave'
            ? 'llave_invalida'
            : diagnostico.motivo === 'modelo_no_disponible'
              ? 'modelo_no_disponible'
              : 'no_se_entendio';
    // La cuota del producto no es un error del proveedor: se reconoce por
    // el texto que escribe el propio runtime al rechazar.
    if (/cuota de IA/i.test(fila.error)) return describirSinSugerencia('cuota_agotada');
    return describirSinSugerencia(codigo);
  }
  if (salida.truncada) return describirSinSugerencia('respuesta_cortada');
  return describirSinSugerencia('no_se_entendio');
}
