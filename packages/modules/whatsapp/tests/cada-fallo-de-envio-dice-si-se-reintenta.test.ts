import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CAUSAS_META,
  causaLegible,
  codigoDelProveedor,
  mensajeDeRechazo,
} from '../application/outbound';

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
 * así que la única forma de que no se olvide es pedirla acá, por escrito.
 *
 * Un `throw new Error` crudo en este archivo o es transitorio Y está en la
 * lista de abajo con su motivo, o falta clasificarlo.
 */

const RAIZ = join(__dirname, '..', 'application');

/**
 * Transitorios a propósito, con el motivo escrito. Si agregas uno, escribe por
 * qué esperar ayuda — y si no puedes escribirlo, es permanente.
 */
const TRANSITORIOS_CON_MOTIVO: Record<string, string> = {
  'El canal no aceptó el envío: HTTP':
    'Es la rama que queda DESPUÉS de rechazoPermanente(): 429 y 5xx. Esos sí se arreglan esperando.',
  'El canal no devolvió el id del mensaje':
    'Una respuesta 2xx sin id es un hipo del proveedor, no una configuración mala: el reintento puede salir bien. ' +
    'Ojo: el mensaje pudo haber salido, y por eso el reintento se apoya en el bloqueo de fila de getOutboundContext.',
  'Zavu no transporta el canal':
    'Se lanza al CONSTRUIR el adaptador, no al enviar: no llega nunca al catch del worker.',
  'No pudimos bajar el adjunto: HTTP':
    'Va en el camino de ENTRADA (normalizar un adjunto que llega), que no pasa por la cola outbound.',
};

function sinComentarios(fuente: string): string {
  return fuente.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('cada fallo de envío dice si se reintenta (#556)', () => {
  it('ningún throw crudo sin clasificar en el adaptador', () => {
    const fuente = sinComentarios(readFileSync(join(RAIZ, 'zavu.ts'), 'utf8'));
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
  });

  it('lo que falta de configuración es permanente, no transitorio', () => {
    const fuente = sinComentarios(readFileSync(join(RAIZ, 'zavu.ts'), 'utf8'));
    // Las dos que causaban el síntoma que vio Lino: sin credencial y sin
    // emisor. Ninguna aparece sola, así que ninguna puede ser transitoria.
    for (const guardia of ['if (!apiKey)', 'if (!senderId)']) {
      const ocurrencias = fuente.split(guardia).length - 1;
      expect(ocurrencias, `esperaba encontrar ${guardia} en el adaptador`).toBeGreaterThan(0);
    }
    expect(fuente).not.toMatch(/if \(!apiKey\) throw new Error\(/);
    expect(fuente).not.toMatch(/if \(!senderId\) throw new Error\(/);
  });

  it('el worker rechaza lo permanente antes de mirar si es el último intento', () => {
    const worker = sinComentarios(
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
  it('saca el código de las formas que usan Zavu y Meta', () => {
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
    expect(codigoDelProveedor('{"error":{"code":"algo_nuevo_de_zavu"}}')).toBeUndefined();
    expect(codigoDelProveedor('')).toBeUndefined();
    // Y entonces se cae al mensaje por status, que también dice qué hacer.
    expect(causaLegible(undefined, mensajeDeRechazo(401))).toMatch(/reconectarlo en Canales/);
  });

  it('cada causa de la tabla está en voz de Pulso: sin código, sin nombre de campo', () => {
    for (const [clave, frase] of Object.entries(CAUSAS_META)) {
      expect(frase, `causa ${clave}`).not.toMatch(/HTTP|[a-z]+_[a-z]+|senderId|null|undefined/);
      expect(frase.trim(), `causa ${clave}`).not.toBe('');
    }
  });
});
