import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CAUSAS_META,
  causaLegible,
  codigoDelProveedor,
  mensajeDeRechazo,
  rechazoPermanente,
} from '../application/outbound';
import { fuenteLimpia } from '@iaxti/core/testing';

/**
 * Guarda: en el camino de envío, todo fallo dice si se reintenta o no (#556).
 *
 * El defecto que arregló #556 no fue un `if` mal escrito: fue que el adaptador
 * lanzaba `new Error` para dos cosas distintas —«el proveedor está caído» y «el
 * canal está mal configurado»— y el worker, que no puede distinguirlas, las
 * reintentaba las cinco veces. Nada fallaba: el mensaje simplemente se quedaba
 * «enviando» varias horas.
 *
 * Es la misma familia de siempre: declarado en un lado, aplicado en ninguno. La
 * clasificación vive en el adaptador porque solo él sabe qué significó ese 400,
 * así que la única forma de que no se olvide es pedirla acá, por escrito. Desde
 * #1339 el adaptador es Zernio (`zernio.ts` + `zernio-base.ts`); Zavu se fue
 * con su archivo y esta guarda apunta al que despacha de verdad.
 *
 * Un `throw new Error` crudo en estos archivos o es transitorio Y está en la
 * lista de abajo con su motivo, o falta clasificarlo.
 */

const RAIZ = join(__dirname, '..', 'application');

/**
 * Transitorios a propósito, con el motivo escrito. Si agregas uno, escribe por
 * qué esperar ayuda — y si no puedes escribirlo, es permanente.
 */
const TRANSITORIOS_CON_MOTIVO: Record<string, string> = {
  'Zernio no transporta el canal':
    'Se lanza al CONSTRUIR el adaptador, no al enviar: no llega nunca al catch del worker.',
  'Zernio no devolvió el id del mensaje':
    'Una respuesta 2xx sin id es un hipo del proveedor, no una configuración mala. ' +
    'La ruta lleva Idempotency-Key y Zernio deduplica, así que el reintento de BullMQ ' +
    'es seguro: el mensaje pudo haber salido, y por eso no se clasifica permanente.',
};

describe('cada fallo de envío dice si se reintenta (#556)', () => {
  it('ningún throw crudo sin clasificar en el adaptador', () => {
    const fuente = fuenteLimpia(readFileSync(join(RAIZ, 'zernio.ts'), 'utf8'));
    const crudos = fuente
      .split('\n')
      .filter((l) => l.includes('throw new Error('))
      .map((l) => l.trim());

    // Primero: que el escáner encuentre algo. Una guarda que no ve ninguna
    // línea pasa siempre, y es peor que no tenerla.
    expect(crudos.length).toBeGreaterThan(0);

    const sinMotivo = crudos.filter(
      (l) => !Object.keys(TRANSITORIOS_CON_MOTIVO).some((k) => l.includes(k)),
    );
    expect(sinMotivo, `Clasifica estos fallos: o ErrorPermanente, o agrégalos con su motivo.\n${sinMotivo.join('\n')}`).toEqual([]);

    // La base del adaptador ni siquiera tiene uno: su único fallo de
    // configuración (la llave ausente) ya es ErrorPermanente. Que siga
    // siéndolo es la mitad de esta guarda.
    const base = fuenteLimpia(readFileSync(join(RAIZ, 'zernio-base.ts'), 'utf8'));
    expect(base.split('\n').filter((l) => l.includes('throw new Error('))).toEqual([]);
  });

  it('lo que falta de configuración es permanente, no transitorio', () => {
    const fuente = fuenteLimpia(readFileSync(join(RAIZ, 'zernio.ts'), 'utf8'));
    // Las dos que hoy causan el síntoma de #556: sin cuenta de Zernio
    // asignada y sin la llave de idempotencia del mensaje. Ninguna se arregla
    // esperando, así que ninguna puede ser transitoria.
    for (const guardia of ['if (!zernioAccountId)', 'if (!message.messageId)']) {
      const ocurrencias = fuente.split(guardia).length - 1;
      expect(ocurrencias, `esperaba encontrar ${guardia} en el adaptador`).toBeGreaterThan(0);
    }
    expect(fuente).not.toMatch(/if \(!zernioAccountId\) throw new Error\(/);
    expect(fuente).not.toMatch(/if \(!message\.messageId\) throw new Error\(/);
    // Y la llave de la cuenta, que vive en el entorno (zernio-base), tampoco.
    const base = fuenteLimpia(readFileSync(join(RAIZ, 'zernio-base.ts'), 'utf8'));
    expect(base).not.toMatch(/if \(!apiKey\) throw new Error\(/);
  });

  it('el worker rechaza lo permanente antes de mirar si es el último intento', () => {
    const worker = fuenteLimpia(
      readFileSync(join(__dirname, '..', '..', '..', '..', 'apps', 'workers', 'src', 'outbound.ts'), 'utf8'),
    );
    const permanente = worker.indexOf('esPermanente(err)');
    const ultimo = worker.indexOf('!esUltimoIntento');
    expect(permanente).toBeGreaterThan(0);
    expect(ultimo).toBeGreaterThan(0);
    // El orden ES la corrección: al revés, lo permanente vuelve a la cola.
    expect(permanente).toBeLessThan(ultimo);
  });
});

describe('el motivo del proveedor se traduce (#556)', () => {
  it('saca el código de las formas que usan los proveedores', () => {
    expect(codigoDelProveedor('{"error":{"code":"whatsapp_window_closed"}}')).toBe(
      'whatsapp_window_closed',
    );
    expect(codigoDelProveedor('{"code":131026}')).toBe(131026);
    expect(codigoDelProveedor('{"errors":[{"code":"daily_limit_exceeded"}]}')).toBe(
      'daily_limit_exceeded',
    );
    // Un cuerpo que no es JSON —HTML de un proxy, texto pelado— igual se lee.
    expect(codigoDelProveedor('rechazado: url_shortener_blocked (sender snd_1)')).toBe(
      'url_shortener_blocked',
    );
  });

  it('un código que no conocemos no inventa una causa', () => {
    expect(codigoDelProveedor('{"error":{"code":"algo_nuevo_del_proveedor"}}')).toBeUndefined();
    expect(codigoDelProveedor('')).toBeUndefined();
    // Y entonces se cae al mensaje por status, que también dice qué hacer.
    expect(causaLegible(undefined, mensajeDeRechazo(401, ''))).toMatch(/reconectarlo en Canales/);
  });

  it('la tabla traduce también los códigos NUMÉRICOS de la Cloud API', () => {
    // Los numéricos son de Meta y siguen llegando cuando el proveedor los
    // pasa. Y el fallback se usa tal cual: no se ignora el detalle crudo.
    expect(causaLegible(131026)).toBe('El número no tiene WhatsApp.');
    expect(causaLegible(999999, 'detalle crudo')).toBe('detalle crudo');
    expect(causaLegible(undefined)).toMatch(/Reintenta en unos minutos/);
  });

  it('cada causa de la tabla está en voz de Pulso: sin código, sin nombre de campo', () => {
    for (const [clave, frase] of Object.entries(CAUSAS_META)) {
      expect(frase, `causa ${clave}`).not.toMatch(/HTTP|[a-z]+_[a-z]+|senderId|null|undefined/);
      expect(frase.trim(), `causa ${clave}`).not.toBe('');
    }
  });
});

describe('un 403 no es una credencial mala (#596)', () => {
  /**
   * El cuerpo de abajo es TEXTUAL: lo que Zavu respondió cuando Lino intentó
   * escribirle a su propio número desde staging. Tres días buscando por qué no
   * se podían enviar mensajes, y el producto decía que había que reconectar el
   * canal. `CAUSAS_META` y `mensajeDeRechazo` siguen traduciéndolo igual
   * (#1339 sacó al proveedor, no el vocabulario de sus rechazos).
   *
   * 401 y 403 estaban juntos en `mensajeDeRechazo`, y no son lo mismo:
   *   401 = «no sé quién eres» → la credencial está mala, hay que reconectar.
   *   403 = «sé quién eres y esto no lo puedes hacer» → la credencial está
   *          PERFECTA y el problema es el destino.
   *
   * Confundirlos no solo no ayuda: manda en la dirección contraria, y
   * reconectar no arregla nada, así que se hace otra vez.
   */
  const CUERPO_REAL = JSON.stringify({
    code: 'forbidden',
    message:
      'Sandbox mode: a test key only reaches the phone numbers of people on your team. ' +
      'Send to one of those, or use a live API key.',
  });

  it('el rechazo de sandbox se explica por lo que ES, no como credencial mala', () => {
    const frase = causaLegible(codigoDelProveedor(CUERPO_REAL), mensajeDeRechazo(403, CUERPO_REAL));
    expect(frase).toMatch(/llave de prueba/);
    expect(frase).toMatch(/números del equipo/);
    // Y NO manda a reconectar, que es lo que hacía y no arreglaba nada.
    expect(frase).not.toMatch(/reconect/i);
    expect(frase).not.toMatch(/credenciales/);
  });

  const SIN_MOTIVO = JSON.stringify({ code: 'forbidden' });

  it('un 403 sin cuerpo reconocible tampoco culpa a la credencial', () => {
    const frase = causaLegible(codigoDelProveedor(SIN_MOTIVO), mensajeDeRechazo(403, SIN_MOTIVO));
    expect(frase).toMatch(/no tiene permitido/);
    expect(frase).toMatch(/La credencial está bien/);
  });

  it('el 401 SÍ es la credencial, y sigue mandando a reconectar', () => {
    // La otra mitad: si se arreglara el 403 rompiendo el 401, el producto
    // dejaría de avisar cuando de verdad hay que reconectar.
    const frase = mensajeDeRechazo(401, '');
    expect(frase).toMatch(/credenciales/);
    expect(frase).toMatch(/reconectarlo en Canales/);
  });

  /**
   * El OTRO 403 (#1178). Textual, medido contra la API de producción el
   * 02-11 mandando el mismo cuerpo al emisor `kd764401…`, que es uno de los dos
   * registros que quedaron del mismo número `+56 9 2201 3949`.
   *
   * Se prueba la composición COMPLETA —`causaLegible(codigoDelProveedor(…),
   * mensajeDeRechazo(…))`— y no `mensajeDeRechazo` sola, porque es lo que corre
   * en el adaptador. Si algún día una clave de `CAUSAS_META` resulta ser subcadena
   * de este texto, `codigoDelProveedor` ganaría y el mensaje nuevo no se vería
   * nunca: probar la función aislada diría que está bien y el producto seguiría
   * mandando a revisar el número del contacto.
   */
  const DESACTIVADO = JSON.stringify({
    code: 'forbidden',
    message:
      'This connection is deactivated. Activate it from Accounts in the dashboard, ' +
      'or with POST /v1/senders/{senderId}/channels/{channel}/activate, to send and ' +
      'receive on this channel.',
  });

  it('el emisor desactivado manda al panel del proveedor, no a revisar el número', () => {
    const frase = causaLegible(codigoDelProveedor(DESACTIVADO), mensajeDeRechazo(403, DESACTIVADO));
    expect(frase).toMatch(/desactivado/i);
    expect(frase).toMatch(/proveedor/);
    // Y NO manda a buscar donde no está: ni el destino, ni el permiso del
    // número, ni reconectar un canal que está sano.
    expect(frase).not.toMatch(/ese número/);
    expect(frase).not.toMatch(/permiso para ese destino/);
    expect(frase).not.toMatch(/reconect/i);
  });

  it('un 403 que NO es desactivación conserva el mensaje de destino', () => {
    // La otra mitad. Sin esto, «arreglar» el caso nuevo podría tragarse el
    // de la llave de prueba, que es el que #596 dejó bien.
    const frase = causaLegible(codigoDelProveedor(SIN_MOTIVO), mensajeDeRechazo(403, SIN_MOTIVO));
    expect(frase).toMatch(/no tiene permitido/);
    expect(frase).not.toMatch(/desactivado/i);
  });

  it('el marcador es el término del proveedor, no su frase entera', () => {
    // Los proveedores reescriben su documentación sin avisar. Lo que no puede
    // pasar es que un cambio de redacción devuelva en silencio al mensaje
    // equivocado.
    const otraRedaccion = JSON.stringify({
      code: 'forbidden',
      message: 'Channel deactivated for this sender.',
    });
    expect(mensajeDeRechazo(403, otraRedaccion)).toMatch(/desactivado/i);
    // Y si el marcador no aparece, cae al genérico del 403: decir menos, no
    // decir otra cosa.
    const desconocido = JSON.stringify({ code: 'forbidden', message: 'Nope.' });
    expect(mensajeDeRechazo(403, desconocido)).toMatch(/no tiene permitido/);
  });

  it('el rechazo de sandbox es PERMANENTE: reintentar no lo arregla', () => {
    // Un 403 no cambia por volver a mandarlo. Sin esto quedaría cinco intentos
    // con backoff antes de contar lo que ya se sabía al primero.
    expect(rechazoPermanente(403)).toBe(true);
    expect(rechazoPermanente(401)).toBe(true);
    // Y lo que sí se arregla esperando sigue reintentando.
    expect(rechazoPermanente(429)).toBe(false);
    expect(rechazoPermanente(503)).toBe(false);
  });
});
