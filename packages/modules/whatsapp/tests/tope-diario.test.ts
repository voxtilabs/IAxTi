import { describe, expect, it } from 'vitest';
import { causaLegible, esTopeDiario, rechazoPermanente } from '../application/outbound';

/**
 * El tope diario del canal (#609).
 *
 * Lo que esto fija es una decisión, no una traducción: **el tope llega como 429
 * y un 429 normalmente sí merece los cinco intentos con backoff.** Este no, y
 * la diferencia no es de estilo: el tope no se libera en treinta segundos, se
 * libera al día siguiente. Con 650 mensajes, reintentar son 3.250 llamadas
 * inútiles y —lo que de verdad importa— horas de retraso antes de que alguien
 * pueda enterarse de qué pasó.
 */
describe('el tope diario del canal', () => {
  it('se reconoce aunque venga como 429, que es el status que SÍ se reintenta', () => {
    expect(rechazoPermanente(429)).toBe(false);
    expect(esTopeDiario('{"errorCode":"DAILY_LIMIT_EXCEEDED"}')).toBe(true);
    expect(esTopeDiario('429 Too Many Requests: daily limit exceeded')).toBe(true);
    expect(esTopeDiario('Daily Limit Reached for this channel')).toBe(true);
  });

  it('no se confunde con un rate limit cualquiera, que sí se reintenta', () => {
    // Un 429 por ráfaga se arregla esperando unos segundos; el tope no. Tratar
    // los dos igual rompe uno de los dos casos, y acá se elige no romper el
    // que se arregla solo.
    expect(esTopeDiario('{"error":"rate limited, retry in 2s"}')).toBe(false);
    expect(esTopeDiario('Too Many Requests')).toBe(false);
    expect(esTopeDiario('')).toBe(false);
  });

  it('el motivo que lee la persona dice qué hacer, y no «reintenta en unos minutos»', () => {
    // El fallback de `causaLegible` dice «Reintenta en unos minutos», que para
    // este caso es consejo EQUIVOCADO: el tope se libera mañana. Era lo que
    // leía el negocio antes de que esta causa existiera.
    const motivo = causaLegible('DAILY_LIMIT_EXCEEDED');
    expect(motivo).toMatch(/tope diario/);
    expect(motivo).not.toMatch(/unos minutos/);
    // Y lo que la campaña busca en `messages.meta->>'error'` es esa frase: si
    // alguien la cambia sin cambiar la consulta, el corte por tope deja de
    // dispararse y la campaña vuelve a fabricar mensajes para un canal lleno.
    expect(motivo.toLowerCase()).toContain('tope diario');
  });
});
