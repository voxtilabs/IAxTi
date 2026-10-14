import { beforeEach, describe, expect, it } from 'vitest';
import { iaSettings, type Provider } from '../domain/config';
import {
  castigar,
  estaCastigado,
  losCastigados,
  olvidarLosCastigos,
  perdonar,
} from '../application/castigados';
import { diagnosticarLaIa } from '../application/diagnostico-ia';

/**
 * No volver a elegir al proveedor que acaba de fallar (#855).
 *
 * El caso que esto existe para evitar, tal como pasó la noche del 11-10:
 *
 *  - GLM era el proveedor por defecto de las ocho tareas de texto y **no
 *    tenía llave en el contenedor** (#853).
 *  - google tenía llave y estaba **sin saldo**.
 *  - `hayLlave` es `Boolean(process.env[...])`, así que google contaba como
 *    disponible. El respaldo lo eligió, mensaje tras mensaje, y las ocho
 *    tareas murieron ahí.
 *  - El diagnóstico decía `ia ✓` porque la credencial existe.
 *
 * El dueño leyó «Hay 1 de 4 con credencial: google» y «8 de 9 no pueden
 * funcionar». Las dos frases eran ciertas y juntas no explicaban nada: el que
 * tenía credencial era el que no servía.
 */
const SOLO = (...cuales: Provider[]) => (p: Provider) => cuales.includes(p);

beforeEach(() => {
  // Estado de módulo: sin esto, el primer test que castigue se lo deja
  // castigado a todos los que corran después en el mismo proceso. Ya pasó en
  // este repo con `ultimoFallo`.
  olvidarLosCastigos();
});

describe('el castigo: qué aparta y qué no', () => {
  it('aparta lo que NO se arregla reintentando', () => {
    for (const motivo of ['sin_saldo', 'sin_llave', 'llave_invalida', 'modelo_no_disponible'] as const) {
      olvidarLosCastigos();
      expect(castigar('openai', motivo), motivo).toBe(true);
      expect(estaCastigado('openai'), motivo).toBe(true);
    }
  });

  it('NO aparta lo que sí se arregla reintentando', () => {
    // Un límite de tasa no es un proveedor roto: es un proveedor ocupado.
    // Apartarlo sería tirar al bueno por estar trabajando.
    for (const motivo of ['cuota_agotada', 'no_contesto_a_tiempo', 'desconocido'] as const) {
      olvidarLosCastigos();
      expect(castigar('openai', motivo), motivo).toBe(false);
      expect(estaCastigado('openai'), motivo).toBe(false);
    }
  });

  it('se vence solo, sin que nadie toque nada', () => {
    let reloj = 1_000_000;
    olvidarLosCastigos(() => reloj);
    castigar('google', 'sin_saldo');
    expect(estaCastigado('google')).toBe(true);
    reloj += 4 * 60_000;
    expect(estaCastigado('google'), 'a los 4 minutos sigue apartado').toBe(true);
    reloj += 2 * 60_000;
    // Esto es lo que hace cierto el mensaje de `sin_saldo`: «carga crédito y
    // el asistente vuelve solo; no hace falta tocar nada acá».
    expect(estaCastigado('google'), 'pasados los 5 ya no').toBe(false);
  });

  it('un éxito lo perdona, aunque el castigo no haya vencido', () => {
    castigar('google', 'sin_saldo');
    perdonar('google');
    expect(estaCastigado('google')).toBe(false);
  });
});

describe('el respaldo salta al que acaba de fallar', () => {
  /**
   * EL CASO del 11-10, adaptado al orden de hoy.
   *
   * Entonces `PROVIDERS` empezaba por google y el respaldo caía ahí. Desde
   * #876 empieza por openai, así que para reproducir el caso hay que castigar
   * al PRIMERO con llave: lo que se prueba es que el respaldo lo salte, no que
   * un orden concreto dé un nombre concreto.
   *
   * Y el pedido va a `anthropic`, que no tiene llave acá: así el respaldo es
   * el que decide, que es la situación del 11-10.
   */
  it('EL CASO del 11-10: con llave y sin saldo, el respaldo elige al otro', () => {
    const hayLlave = SOLO('openai', 'google');
    const pedido = { ia: { tasks: { sugerir: { provider: 'anthropic', model: 'x' } } } };

    const sinCastigo = iaSettings(pedido, hayLlave);
    expect(sinCastigo.tasks.sugerir.provider, 'sin castigo, el respaldo elige el primero con llave').toBe('openai');

    castigar('openai', 'sin_saldo');
    const conCastigo = iaSettings(pedido, hayLlave, estaCastigado);

    // Lo que costó la noche: antes volvía a elegir al que acababa de fallar.
    expect(conCastigo.tasks.sugerir.provider).not.toBe(sinCastigo.tasks.sugerir.provider);
    expect(conCastigo.tasks.sugerir.provider).toBe('google');
  });

  it('pero si el elegido TIENE llave, se usa igual: el castigo mueve el respaldo, no la elección', () => {
    const hayLlave = SOLO('google', 'openai');
    castigar('google', 'sin_saldo');
    // Lo pidió a mano Y tiene llave: se respeta. Quien eligió merece ver SU
    // error con el nombre de SU proveedor, y un castigo puede ser de más.
    const s = iaSettings(
      { ia: { tasks: { sugerir: { provider: 'google', model: 'gemini-flash-latest' } } } },
      hayLlave,
      estaCastigado,
    );
    expect(s.tasks.sugerir.provider).toBe('google');
  });

  it('«solo este proveedor» NO se mueve ni castigado: es un compromiso escrito', () => {
    const hayLlave = SOLO('google', 'openai');
    castigar('google', 'sin_saldo');
    const s = iaSettings({ ia: { soloProveedor: 'google' } }, hayLlave, estaCastigado);
    // Cambiarlo en silencio sería mandarle los datos del cliente al proveedor
    // que pidió no usar. Que falle con su mensaje es lo correcto.
    for (const [tarea, tm] of Object.entries(s.tasks)) {
      if (tarea === 'transcribir') continue; // capacidad, no preferencia
      expect(tm.provider, tarea).toBe('google');
    }
  });

  it('si TODOS están castigados, se usa uno igual: el castigo no es una condena', () => {
    const hayLlave = SOLO('openai');
    castigar('openai', 'sin_saldo');
    const s = iaSettings(null, hayLlave, estaCastigado);
    // Un castigado es mejor que nada, y el único que puede desmentirlo es él.
    // Si no se le vuelve a hablar nunca, el castigo se vuelve permanente.
    expect(s.tasks.sugerir.provider).toBe('openai');
  });
});

describe('y el diagnóstico lo dice', () => {
  it('la frase que faltaba: «tiene credencial» y «acaba de fallar» a la vez', () => {
    const d = diagnosticarLaIa({
      settings: null,
      hayLlave: SOLO('openai', 'google'),
      castigados: () => [{ provider: 'openai', motivo: 'sin_saldo' }],
    });
    const paso = d.pasos.find((p) => p.id === 'proveedor_castigado');
    expect(paso, 'el diagnóstico no menciona a los apartados').toBeTruthy();
    expect(paso!.detalle).toContain('openai');
    // En la voz del producto, no el nombre interno del motivo.
    expect(paso!.detalle).toContain('sin saldo');
    expect(paso!.detalle).not.toContain('sin_saldo');
    // Y qué hacer: la promesa de que vuelve solo, que es la que el castigo
    // con vencimiento hace cierta.
    expect(paso!.queHacer).toContain('sin que toques nada');
  });

  it('sin nadie apartado, el paso no aparece: no se inventa un aviso', () => {
    const d = diagnosticarLaIa({ settings: null, hayLlave: SOLO('openai'), castigados: () => [] });
    expect(d.pasos.some((p) => p.id === 'proveedor_castigado')).toBe(false);
  });

  it('no es «mal» mientras el respaldo trabaje: pintar rojo lo que anda enseña a no mirar', () => {
    const d = diagnosticarLaIa({
      settings: null,
      hayLlave: SOLO('openai', 'google'),
      castigados: () => [{ provider: 'google', motivo: 'sin_saldo' }],
    });
    expect(d.pasos.find((p) => p.id === 'proveedor_castigado')!.estado).toBe('atencion');
    expect(d.problema).toBeNull();
  });
});

describe('losCastigados() cuenta solo los vivos', () => {
  it('un castigo vencido no figura', () => {
    let reloj = 1_000_000;
    olvidarLosCastigos(() => reloj);
    castigar('google', 'sin_saldo');
    castigar('anthropic', 'llave_invalida');
    expect(losCastigados()).toHaveLength(2);
    reloj += 6 * 60_000;
    expect(losCastigados()).toHaveLength(0);
  });
});
