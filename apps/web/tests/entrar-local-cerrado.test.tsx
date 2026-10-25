// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import EntrarLocalPage from '../app/entrar-local/page';

/**
 * La doble cerradura de /entrar-local (#1047), probada USÁNDOLA (#564):
 * se llama al server component con cada combinación de ambiente y se mira
 * si abre o lanza el 404 de Next. Una guarda de fuente diría «el if está
 * escrito»; esta dice qué pasa cuando alguien golpea la puerta.
 */

const ORIGINAL = { flag: process.env.IAXTI_LOGIN_DEV, env: process.env.IAXTI_ENV };

afterEach(() => {
  if (ORIGINAL.flag === undefined) delete process.env.IAXTI_LOGIN_DEV;
  else process.env.IAXTI_LOGIN_DEV = ORIGINAL.flag;
  if (ORIGINAL.env === undefined) delete process.env.IAXTI_ENV;
  else process.env.IAXTI_ENV = ORIGINAL.env;
});

describe('la doble cerradura de /entrar-local (#1047)', () => {
  it('sin el flag, la página NO existe — ni en local', () => {
    delete process.env.IAXTI_LOGIN_DEV;
    delete process.env.IAXTI_ENV;
    expect(() => EntrarLocalPage()).toThrow(); // el notFound() de Next lanza
  });

  it('con el flag pero en staging o producción, tampoco — la segunda cerradura manda', () => {
    process.env.IAXTI_LOGIN_DEV = '1';
    for (const ambiente of ['staging', 'production']) {
      process.env.IAXTI_ENV = ambiente;
      expect(() => EntrarLocalPage(), `abrió con IAXTI_ENV=${ambiente}`).toThrow();
    }
  });

  it('un valor del flag que no es exactamente "1" no abre nada', () => {
    delete process.env.IAXTI_ENV;
    for (const valor of ['true', 'si', '0', ' 1']) {
      process.env.IAXTI_LOGIN_DEV = valor;
      expect(() => EntrarLocalPage(), `abrió con IAXTI_LOGIN_DEV=${JSON.stringify(valor)}`).toThrow();
    }
  });

  it('con el flag y ambiente local, la página abre', () => {
    process.env.IAXTI_LOGIN_DEV = '1';
    delete process.env.IAXTI_ENV;
    expect(EntrarLocalPage()).toBeTruthy();
  });
});
