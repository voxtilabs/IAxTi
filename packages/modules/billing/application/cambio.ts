import type { Pool, PoolClient } from 'pg';
import type { Cambio } from '../domain/cambio';

/** El par que el producto usa hoy. Los costos de Meta y de IA llegan en USD. */
export const PAR = 'USD/CLP';

/** En palabras, para que un valor raro se pueda auditar. */
export const FUENTE = 'Banco Central (mindicador.cl)';

/** La serie que publica mindicador.cl, en lo poco que nos sirve de ella. */
interface SerieDeMindicador {
  serie?: Array<{ fecha?: string; valor?: number }>;
}

/**
 * El día en ISO de una fecha que viene con hora.
 *
 * mindicador publica `2026-10-16T03:00:00.000Z`, que son las 00:00 en Santiago
 * del 16. Tomar `toISOString().slice(0, 10)` daría el 16 también, pero por
 * casualidad: con otro offset —o si algún día publican a las 21:00— daría el
 * día anterior. Así que se corta la cadena ANTES de interpretarla como
 * instante: el día que ellos escriben es el día que vale.
 */
function diaDe(fecha: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(fecha);
  return m ? m[1] : null;
}

/**
 * Traer el dólar observado de los últimos días.
 *
 * `traer` se inyecta para poder probar esto sin salir a internet, y el valor
 * por defecto es `fetch` porque el worker no tiene que saber de inyecciones.
 *
 * Se piden varios días y no solo hoy a propósito: el Banco Central no publica
 * fines de semana ni feriados, así que «el dólar de ayer» puede no existir, y
 * un costo del sábado necesita el valor del sábado —que no hay— o quedar
 * dicho como faltante. Guardar la serie completa que ellos publican deja la
 * tabla igual a la fuente, sin inventar los días que no están.
 */
export async function traerDolarObservado(
  traer: typeof fetch = fetch,
): Promise<Array<{ day: string; value: number }>> {
  const r = await traer('https://mindicador.cl/api/dolar');
  if (!r.ok) throw new Error(`mindicador respondió ${r.status}`);
  const cuerpo = (await r.json()) as SerieDeMindicador;
  const valores: Array<{ day: string; value: number }> = [];
  for (const punto of cuerpo.serie ?? []) {
    const day = punto.fecha ? diaDe(punto.fecha) : null;
    // Un punto sin fecha o sin valor positivo no se guarda y no tumba el resto:
    // la fuente es de un tercero y lo que se puede usar se usa.
    if (!day || typeof punto.valor !== 'number' || !(punto.valor > 0)) continue;
    valores.push({ day, value: punto.valor });
  }
  return valores;
}

/**
 * Guardar los valores, sin pisar lo que ya estaba igual.
 *
 * `ON CONFLICT … DO UPDATE` y no `DO NOTHING`: el Banco Central corrige valores
 * publicados, y quedarse con el primero que vimos sería preferir nuestra copia
 * vieja a la fuente. Devuelve cuántos cambiaron de verdad, que es lo que vale
 * mirar en el log: «guardé 30» cada día no dice nada, «cambió 1» sí.
 */
export async function guardarCambios(
  cliente: PoolClient | Pick<Pool, 'query'>,
  valores: Array<{ day: string; value: number }>,
  fuente = FUENTE,
): Promise<number> {
  let cambiados = 0;
  for (const { day, value } of valores) {
    const r = await cliente.query(
      `INSERT INTO fx_rates (pair, day, value, source)
            VALUES ($1, $2::date, $3, $4)
       ON CONFLICT (pair, day) DO UPDATE SET value = EXCLUDED.value, source = EXCLUDED.source
         WHERE fx_rates.value <> EXCLUDED.value`,
      [PAR, day, value, fuente],
    );
    cambiados += r.rowCount ?? 0;
  }
  return cambiados;
}

/**
 * El cambio de UN día, o null.
 *
 * Null es una respuesta legítima —el Banco Central no publica sábados— y el
 * dominio sabe qué hacer con ella: decir que falta, no convertir con otro día.
 */
export async function cambioDelDia(
  cliente: PoolClient | Pick<Pool, 'query'>,
  dia: string,
): Promise<Cambio | null> {
  const r = await cliente.query<{ value: string; day: Date; source: string }>(
    'SELECT value, day, source FROM fx_rates WHERE pair = $1 AND day = $2::date',
    [PAR, dia],
  );
  const fila = r.rows[0];
  if (!fila) return null;
  return {
    // `numeric` llega como string: `Number` acá, una vez, y no en cada pantalla.
    valor: Number(fila.value),
    fecha: dia,
    fuente: fila.source,
  };
}

/**
 * Los cambios de un rango, por día.
 *
 * Un panel convierte muchos costos de muchos días: pedirlos uno por uno serían
 * treinta consultas para un mes. El `Map` viene con los días que EXISTEN, así
 * que preguntarle por uno que falta devuelve `undefined` y el dominio lo trata
 * como lo que es.
 */
export async function cambiosDelRango(
  cliente: PoolClient | Pick<Pool, 'query'>,
  desde: string,
  hasta: string,
): Promise<Map<string, Cambio>> {
  const r = await cliente.query<{ value: string; day: Date; source: string }>(
    `SELECT value, day, source FROM fx_rates
      WHERE pair = $1 AND day BETWEEN $2::date AND $3::date`,
    [PAR, desde, hasta],
  );
  const porDia = new Map<string, Cambio>();
  for (const fila of r.rows) {
    // `day` vuelve como Date del driver; el día en ISO es lo que se indexa.
    const dia = fila.day.toISOString().slice(0, 10);
    porDia.set(dia, { valor: Number(fila.value), fecha: dia, fuente: fila.source });
  }
  return porDia;
}

/**
 * Lo que corre el repetible `billing.fx`: traer y guardar.
 *
 * Es de plataforma, no por tenant: el dólar es el mismo para todos, así que no
 * hay `withTenant` ni barrido. Una consulta al día a una API pública.
 */
export async function sincronizarCambio(
  pool: Pool,
  opciones: { traer?: typeof fetch } = {},
): Promise<{ traidos: number; cambiados: number }> {
  const valores = await traerDolarObservado(opciones.traer);
  const cambiados = await guardarCambios(pool, valores);
  return { traidos: valores.length, cambiados };
}
