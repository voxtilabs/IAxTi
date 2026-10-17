/**
 * Convertir a pesos, o decir que no se puede (#796).
 *
 * Las tres reglas del issue, en una función:
 *
 *  1. se convierte con el dólar DEL DÍA DEL COSTO, no del día de la consulta;
 *  2. cada valor viene con su fecha y su fuente;
 *  3. si falta el de ese día, **no** se convierte con el de otra fecha.
 *
 * La tercera es la que decide la forma del tipo. Devolver `0`, o `null`, o el
 * dólar de ayer, son las tres maneras de que el panel muestre un número que
 * nadie puede defender: el cliente pregunta «¿y este costo de dónde sale?» y la
 * respuesta es «de un dólar de otro día». Así que el resultado es una de dos
 * cosas, y quien lo muestra tiene que elegir qué hacer con la segunda.
 */
export interface Cambio {
  /** El valor. Llega como `string` desde `numeric`, y acá ya es número. */
  valor: number;
  /** El día al que corresponde, en ISO (`2026-10-16`). */
  fecha: string;
  /** En palabras: «Banco Central (mindicador.cl)». */
  fuente: string;
}

export type EnPesos =
  | { clp: number; cambio: Cambio }
  /** No hay dólar para ese día. `dia` es el que faltaba, para poder decirlo. */
  | { falta: true; dia: string };

/** ¿Se pudo convertir? Para que quien lo use no tenga que mirar las llaves. */
export function seConvirtio(r: EnPesos): r is { clp: number; cambio: Cambio } {
  return 'clp' in r;
}

/**
 * Pesos a partir de dólares, con el cambio de ese día.
 *
 * Redondea al peso: Chile no tiene centavos y mostrar `$11.802,76` en un panel
 * de costos es precisión inventada. El redondeo se hace UNA vez, acá, y no en
 * cada pantalla — dos pantallas redondeando distinto el mismo costo es la
 * clase de diferencia que hace dudar de todo el tablero.
 */
export function aPesos(usd: number, cambio: Cambio | null, dia: string): EnPesos {
  if (!cambio) return { falta: true, dia };
  // Un cambio de otro día no sirve, y que llegue acá es un error de quien
  // consulta: se trata como si faltara, que es lo honesto, y no se calla.
  if (cambio.fecha !== dia) return { falta: true, dia };
  return { clp: Math.round(usd * cambio.valor), cambio };
}
