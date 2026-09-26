import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CAUSAS_META,
  causaLegible,
  codigoDelProveedor,
  mensajeDeRechazo,
  rechazoPermanente,
} from '../application/outbound';
import { createZavuProvider } from '../application/zavu';

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

describe('un reintento no manda el mensaje dos veces (#585)', () => {
  /**
   * El bloqueo de fila impide que dos consumidores manden el mismo mensaje. Lo que
   * NO cubre es el caso que de verdad pasa: el primer intento llega al proveedor,
   * el proveedor lo acepta, y la respuesta se pierde. Nosotros lanzamos, BullMQ
   * reintenta, y el cliente recibe el mismo mensaje dos veces — la fila sigue en
   * `queued` porque nunca nos llegó el id del proveedor.
   *
   * Zavu tiene `idempotencyKey` en su API y no lo estábamos usando. Lo comprobé en
   * su OpenAPI, no en su blog: `docs.zavu.dev/openapi.json`.
   */
  it('el envío manda idempotencyKey con NUESTRO id del mensaje', async () => {
    const llamadas: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (url: string, init: { body: string }) => {
      llamadas.push({ url: String(url), body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ id: 'wamid.1' }) };
    });
    process.env.ZAVU_KEY_IDEM = 'zv_test';
    const p = createZavuProvider('whatsapp', {
      apiBase: 'https://zavu.test/v1',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await p.send(
      {
        id: 'cuenta-1',
        tenantId: 'tenant-1',
        kind: 'whatsapp',
        name: 'n',
        state: 'active',
        credentialRef: 'ZAVU_KEY_IDEM',
        config: { senderId: 'snd_1' },
      },
      { to: '+56987654321', type: 'texto', body: 'Hola', messageId: 'msg-abc-123' },
    );
    delete process.env.ZAVU_KEY_IDEM;

    expect(llamadas).toHaveLength(1);
    // La llave es nuestro id: único, estable entre reintentos, y no cambia si el
    // job se reencola. Cualquier otra cosa (un random, la hora) no serviría.
    expect(llamadas[0]!.body.idempotencyKey).toBe('msg-abc-123');
  });

  it('el mismo mensaje reintentado manda la MISMA llave', async () => {
    const llaves: unknown[] = [];
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      llaves.push(JSON.parse(init.body).idempotencyKey);
      return { ok: true, status: 200, json: async () => ({ id: 'wamid.1' }) };
    });
    process.env.ZAVU_KEY_IDEM2 = 'zv_test';
    const p = createZavuProvider('whatsapp', {
      apiBase: 'https://zavu.test/v1',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const cuenta = {
      id: 'cuenta-1',
      tenantId: 'tenant-1',
      kind: 'whatsapp' as const,
      name: 'n',
      state: 'active' as const,
      credentialRef: 'ZAVU_KEY_IDEM2',
      config: { senderId: 'snd_1' },
    };
    const mensaje = { to: '+56987654321', type: 'texto', body: 'Hola', messageId: 'msg-xyz' };
    await p.send(cuenta, mensaje);
    await p.send(cuenta, mensaje);
    delete process.env.ZAVU_KEY_IDEM2;
    expect(llaves).toEqual(['msg-xyz', 'msg-xyz']);
  });
});

describe('el proveedor no puede saltarse nuestras reglas (#589)', () => {
  /**
   * Zavu trae el fallback a SMS ENCENDIDO por defecto, y nunca lo apagamos. Eso
   * dejaba sin efecto la ventana de 24 h, el consentimiento por canal y la
   * plantilla aprobada: el worker rechaza lo libre fuera de la ventana, y el
   * proveedor lo mandaba igual por otra vía.
   *
   * Lo encontré leyendo las REGLAS DE NEGOCIO de su documentación, no el esquema:
   * el esquema solo dice que el campo existe.
   */
  async function cuerpoDeUnEnvio(): Promise<Record<string, unknown>> {
    let cuerpo: Record<string, unknown> = {};
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      cuerpo = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ id: 'wamid.1' }) };
    });
    process.env.ZAVU_KEY_FB = 'zv_test';
    const p = createZavuProvider('whatsapp', {
      apiBase: 'https://zavu.test/v1',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await p.send(
      {
        id: 'cuenta-fb',
        tenantId: 'tenant-fb',
        kind: 'whatsapp',
        name: 'n',
        state: 'active',
        credentialRef: 'ZAVU_KEY_FB',
        config: { senderId: 'snd_fb' },
      },
      { to: '+56987654321', type: 'texto', body: 'Hola' },
    );
    delete process.env.ZAVU_KEY_FB;
    return cuerpo;
  }

  it('todo envío pide explícitamente que NO caiga a SMS', async () => {
    const cuerpo = await cuerpoDeUnEnvio();
    // `undefined` no sirve: el defecto del proveedor es `true`. Tiene que ir el
    // false explícito en el cuerpo.
    expect(cuerpo.fallbackEnabled).toBe(false);
  });

  it('y va en el MISMO envío, no en una configuración de cuenta', async () => {
    // Un ajuste en el panel del proveedor se puede cambiar desde afuera y nadie
    // se enteraría. En el cuerpo de cada mensaje, no.
    const cuerpo = await cuerpoDeUnEnvio();
    expect(Object.keys(cuerpo)).toContain('fallbackEnabled');
    expect(cuerpo.channel).toBe('whatsapp');
  });
});

describe('un 403 no es una credencial mala (#596)', () => {
  /**
   * El cuerpo de abajo es TEXTUAL: lo que Zavu respondió cuando Lino intentó
   * escribirle a su propio número desde staging. Tres días buscando por qué no
   * se podían enviar mensajes, y el producto decía que había que reconectar el
   * canal.
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
    const frase = causaLegible(codigoDelProveedor(CUERPO_REAL), mensajeDeRechazo(403));
    expect(frase).toMatch(/llave de prueba/);
    expect(frase).toMatch(/números del equipo/);
    // Y NO manda a reconectar, que es lo que hacía y no arreglaba nada.
    expect(frase).not.toMatch(/reconect/i);
    expect(frase).not.toMatch(/credenciales/);
  });

  it('un 403 sin cuerpo reconocible tampoco culpa a la credencial', () => {
    const frase = causaLegible(codigoDelProveedor('{"code":"forbidden"}'), mensajeDeRechazo(403));
    expect(frase).toMatch(/no tiene permitido/);
    expect(frase).toMatch(/La credencial está bien/);
  });

  it('el 401 SÍ es la credencial, y sigue mandando a reconectar', () => {
    // La otra mitad: si se arreglara el 403 rompiendo el 401, el producto
    // dejaría de avisar cuando de verdad hay que reconectar.
    const frase = mensajeDeRechazo(401);
    expect(frase).toMatch(/credenciales/);
    expect(frase).toMatch(/reconectarlo en Canales/);
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
