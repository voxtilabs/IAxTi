import { describe, expect, it, vi } from 'vitest';
import {
  CANDADO_TTL_MS,
  candadoEnRedis,
  llaveDelJob,
  sinSolaparse,
  type CandadoCompartido,
} from '../src/sin-solaparse';

// Esta suite existe porque la anterior no probaba nada: aseguraba el TEXTO de
// main.ts (`expect(MAIN).toContain('enCurso.has(llave)')`), y eso pasa con el
// cuerpo del `if` vacío, pasa sin el `add`, y se pone rojo cuando alguien
// reformatea main.ts sin tocar ningún archivo en común. Acá se llama dos veces a
// la vez y se mira qué devuelve, que es la pregunta de verdad.

/** Una promesa que resuelve cuando yo diga, para tener dos pasadas encimadas. */
function enEspera<T>(): { promesa: Promise<T>; resolver: (v: T) => void } {
  let resolver!: (v: T) => void;
  const promesa = new Promise<T>((r) => (resolver = r));
  return { promesa, resolver };
}

const job = (name: string, tenantId?: string) => ({ name, data: tenantId ? { tenantId } : {} });

describe('una pasada no se pisa con la anterior (#61)', () => {
  it('la segunda pasada del MISMO repetible se salta mientras la primera corre', async () => {
    const primera = enEspera<string>();
    const corridas: string[] = [];
    const correr = vi.fn(async (j: { name: string }) => {
      corridas.push(j.name);
      return primera.promesa;
    });
    const guardado = sinSolaparse(correr, undefined, () => {});

    const a = guardado(job('calendar.reminders'));
    // Sin await de por medio: la segunda entra con la primera todavía corriendo.
    const b = await guardado(job('calendar.reminders'));

    expect(b).toEqual({ skipped: true, reason: 'la pasada anterior no ha terminado' });
    expect(correr).toHaveBeenCalledTimes(1);

    primera.resolver('listo');
    expect(await a).toBe('listo');
    expect(corridas).toEqual(['calendar.reminders']);
  });

  it('cuando la primera termina, la siguiente pasada SÍ corre', async () => {
    const correr = vi.fn(async () => 'ok');
    const guardado = sinSolaparse(correr, undefined, () => {});
    expect(await guardado(job('conversations.checks'))).toBe('ok');
    expect(await guardado(job('conversations.checks'))).toBe('ok');
    expect(correr).toHaveBeenCalledTimes(2);
  });

  it('una pasada que REVIENTA suelta la llave: si no, el barrido no vuelve a correr nunca', async () => {
    const correr = vi
      .fn()
      .mockRejectedValueOnce(new Error('el proveedor se cayó'))
      .mockResolvedValueOnce('ok');
    const guardado = sinSolaparse(correr, undefined, () => {});
    await expect(guardado(job('knowledge.reindex'))).rejects.toThrow('el proveedor se cayó');
    expect(await guardado(job('knowledge.reindex'))).toBe('ok');
  });

  it('dos negocios distintos del mismo barrido SÍ corren a la vez: para eso existe padre/hijo', async () => {
    const espera = enEspera<string>();
    const correr = vi.fn(async () => espera.promesa);
    const guardado = sinSolaparse(correr, undefined, () => {});
    const a = guardado(job('conversations.retention.tenant', 'negocio-1'));
    const b = guardado(job('conversations.retention.tenant', 'negocio-2'));
    // Ninguna se saltó: la llave lleva el tenant.
    expect(correr).toHaveBeenCalledTimes(2);
    espera.resolver('ok');
    expect(await a).toBe('ok');
    expect(await b).toBe('ok');
  });

  it('la llave lleva el tenant, y sin tenant es el nombre solo', () => {
    expect(llaveDelJob(job('calendar.reminders'))).toBe('calendar.reminders:');
    expect(llaveDelJob(job('conversations.retention.tenant', 'n1'))).toBe(
      'conversations.retention.tenant:n1',
    );
    // `data` nulo no puede reventar la llave: un repetible viejo puede no traer
    // nada, y un TypeError acá tumbaría el barrido entero.
    expect(llaveDelJob({ name: 'x', data: null })).toBe('x:');
  });
});

describe('el candado compartido, que es el del despliegue', () => {
  // Durante un despliegue el contenedor viejo drena sus jobs mientras el nuevo
  // arranca: dos procesos, y el guardián en memoria no los ve. En esta cola
  // viven `knowledge.reindex` —que le paga al proveedor por fuente— y
  // `conversations.retention.tenant`, que borra en R2 y no se deshace.
  it('si otro proceso lo tiene tomado, la pasada se salta', async () => {
    const otroProceso: CandadoCompartido = {
      tomar: vi.fn(async () => false),
      soltar: vi.fn(async () => {}),
    };
    const correr = vi.fn(async () => 'ok');
    const guardado = sinSolaparse(correr, otroProceso, () => {});
    expect(await guardado(job('knowledge.reindex'))).toEqual({
      skipped: true,
      reason: 'la pasada anterior corre en otro proceso',
    });
    expect(correr).not.toHaveBeenCalled();
  });

  it('se suelta al terminar, también cuando la pasada revienta', async () => {
    const candado: CandadoCompartido = {
      tomar: vi.fn(async () => true),
      soltar: vi.fn(async () => {}),
    };
    const guardado = sinSolaparse(vi.fn().mockRejectedValue(new Error('pum')), candado, () => {});
    await expect(guardado(job('calendar.reminders'))).rejects.toThrow('pum');
    expect(candado.soltar).toHaveBeenCalledWith('calendar.reminders:');
  });

  it('se toma con NX y con TTL: sin TTL, un proceso que muere bloquea el barrido para siempre', async () => {
    const redis = { set: vi.fn(async () => 'OK'), eval: vi.fn(async () => 1) };
    const candado = candadoEnRedis(redis);
    expect(await candado.tomar('calendar.reminders:', CANDADO_TTL_MS)).toBe(true);
    const [llave, valor, modo, ttl, nx] = redis.set.mock.calls[0] as unknown as [
      string,
      string,
      string,
      number,
      string,
    ];
    expect(llave).toBe('candado:scheduled:calendar.reminders:');
    expect(modo).toBe('PX');
    expect(ttl).toBe(CANDADO_TTL_MS);
    expect(nx).toBe('NX');
    // El valor identifica a ESTE proceso: es lo que permite soltar solo lo propio.
    expect(valor).toContain(String(process.pid));
  });

  it('soltar solo borra si el valor sigue siendo el nuestro', async () => {
    const redis = { set: vi.fn(async () => 'OK'), eval: vi.fn(async () => 1) };
    const candado = candadoEnRedis(redis);
    await candado.tomar('k', 1000);
    await candado.soltar('k');
    const [script, numKeys, llave, valor] = redis.eval.mock.calls[0] as unknown as [
      string,
      number,
      string,
      string,
    ];
    // Un DEL a secas le quitaría el candado a la pasada siguiente cuando la
    // nuestra se pasó del TTL. El script compara antes de borrar.
    expect(script).toContain('redis.call("get", KEYS[1]) == ARGV[1]');
    expect(script).toContain('del');
    expect(numKeys).toBe(1);
    expect(llave).toBe('candado:scheduled:k');
    expect(valor).toContain(String(process.pid));
  });

  it('lo que no se tomó no se suelta: no se le quita el candado a otro', async () => {
    const redis = { set: vi.fn(async () => null), eval: vi.fn(async () => 1) };
    const candado = candadoEnRedis(redis);
    expect(await candado.tomar('k', 1000)).toBe(false);
    await candado.soltar('k');
    expect(redis.eval).not.toHaveBeenCalled();
  });
});
