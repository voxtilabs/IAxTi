/**
 * El cupo diario del canal, y la parte que se le reserva a las personas
 * (#1248).
 *
 * Medido el 3 de noviembre en el Tech AI Summit: el pulso del evento mandó
 * **182 mensajes** sobre 91 entrantes, y al cerrar el stand los 31 mensajes de
 * despedida fallaron TODOS con «el canal llegó a su tope diario». El tope es
 * del canal entero: ni un mensaje de servicio dentro de la ventana de 24 h
 * pasa.
 *
 * Dos defectos, y este archivo atiende el segundo:
 *
 *  1. Nadie lo vio venir. Se gastó a lo largo de seis horas sin un aviso.
 *  2. **El automatismo se comió el cupo del humano.** Un flujo que escribe
 *     solo consumió el 69 % de los salientes del día y dejó sin espacio al
 *     mensaje que una persona quería mandar — el de cierre, el que deja la
 *     relación bien.
 *
 * Lo que empieza el negocio solo se difiere cuando ya no queda margen; lo que
 * manda una persona nunca. No se pierde nada: un diferido sale al día
 * siguiente, que es exactamente lo que el mensaje del pulso puede esperar y el
 * de despedida no.
 *
 * Es puro a propósito: la decisión no necesita base, y así se puede probar
 * cada frontera sin montar un tenant.
 */

/**
 * El tope de un número sin medio de pago configurado en Meta.
 *
 * Es el que se midió en el evento, y es el que corresponde asumir cuando no
 * sabemos el real: equivocarse hacia abajo difiere un automatismo —que sale
 * mañana— y equivocarse hacia arriba pierde el mensaje de una persona.
 */
export const TOPE_SI_NO_SE_SABE = 250;

/**
 * Cuántos mensajes quedan para las personas aunque el automatismo quiera más.
 *
 * 50 sobre 250 es el 20 %. Sale de lo medido: 31 de despedida más los sueltos
 * del cierre entraban de sobra en 50, y 182 automáticos seguían cabiendo.
 */
export const RESERVA_PARA_PERSONAS = 50;

export interface CupoDelDia {
  /** Salientes del canal en el día local del negocio. */
  enviados: number;
  /** El tope del canal, el configurado o el asumido. */
  tope: number;
  /** Lo que no se le presta a un automatismo. */
  reserva: number;
  /** Lo que queda para CUALQUIERA. */
  quedan: number;
  /** Lo que queda para un automatismo, descontada la reserva. */
  quedanParaAutomatismos: number;
  /** `true` si el tope salió de `TOPE_SI_NO_SE_SABE` y no de la configuración. */
  topeAsumido: boolean;
}

/** Lo que el canal guarda en su `config`. Las dos claves son opcionales. */
export interface CupoConfigurado {
  topeDiario?: unknown;
  reservaParaPersonas?: unknown;
}

/** Un entero positivo, o `null` si lo que vino no sirve. */
function enteroPositivo(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

export function cupoDelDia(input: { enviados: number; config?: CupoConfigurado }): CupoDelDia {
  const configurado = enteroPositivo(input.config?.topeDiario);
  const tope = configurado ?? TOPE_SI_NO_SE_SABE;
  // La reserva nunca se come el tope entero: un canal con tope 20 y reserva 50
  // dejaría a los automatismos sin nada para siempre, y entonces la primera
  // campaña «no funciona» sin que nada lo explique. El tope manda.
  const reserva = Math.min(
    enteroPositivo(input.config?.reservaParaPersonas) ?? RESERVA_PARA_PERSONAS,
    Math.floor(tope / 2),
  );
  const enviados = Math.max(0, Math.floor(input.enviados));
  const quedan = Math.max(0, tope - enviados);
  return {
    enviados,
    tope,
    reserva,
    quedan,
    quedanParaAutomatismos: Math.max(0, quedan - reserva),
    topeAsumido: configurado === null,
  };
}

/**
 * ¿Hay margen para un mensaje que empieza el negocio?
 *
 * Lo que manda una persona no pasa por acá: siempre sale mientras quede cupo
 * del canal, y si no queda, el proveedor lo dirá con su propio error. Esta
 * función existe para que ese caso no llegue nunca.
 */
export function hayMargenParaUnAutomatismo(cupo: CupoDelDia): boolean {
  return cupo.quedanParaAutomatismos > 0;
}

/**
 * Cuánto falta para que el proveedor reinicie el cupo.
 *
 * **Medianoche UTC**, y está medido: el 3 de noviembre el cupo se renovó a las
 * 21:00 de Chile. No es la medianoche del negocio, aunque sería lo intuitivo —
 * diferir hasta la medianoche local dejaría el mensaje esperando tres horas
 * más de lo necesario, y en el otro sentido lo soltaría antes del reinicio
 * para que vuelva a fallar.
 *
 * El mínimo de un minuto evita un `delay` de 0 ms justo en el cambio de día,
 * que haría girar el job sin esperar.
 */
export function msHastaElReinicioDelCupo(ahora: Date = new Date()): number {
  const t = ahora.getTime();
  const DIA = 86_400_000;
  const faltan = DIA - (((t % DIA) + DIA) % DIA);
  return Math.max(60_000, faltan);
}
