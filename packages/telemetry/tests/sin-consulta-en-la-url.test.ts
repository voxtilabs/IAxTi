import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  breadcrumbSinConsulta,
  instrumentacionUndiciSinConsulta,
  urlSinConsulta,
} from '../src/sin-consulta-en-la-url';

/**
 * El teléfono del cliente no sale a Grafana ni a Sentry (#1170).
 *
 * Desde #1170 el camino de entrada le pregunta a Zavu el nombre de perfil de
 * quien escribe con `GET /contacts?phoneNumber=+5699…`, y es el PRIMER lugar
 * del repo que mete un número de cliente en un query string. Hasta entonces
 * toda llamada a Zavu era `POST /messages` con el teléfono en el cuerpo, que
 * ninguna instrumentación copia.
 *
 * Las dos fugas eran automáticas y ninguna pasaba por `textoDeLog`:
 * `instrumentation-undici` escribe `url.full`/`url.query` en el span (sampler
 * `AlwaysOn`, o sea el 100 % exportado), y el breadcrumb de
 * `nativeNodeFetchIntegration` guarda `http.query`.
 */

const NUMERO = '56912345678';
const URL_CON_NUMERO = `https://api.zavu.dev/v1/contacts?phoneNumber=%2B${NUMERO}`;

describe('la URL que queda registrada no lleva la consulta', () => {
  it('se corta en el `?`, y queda lo que sirve para diagnosticar', () => {
    expect(urlSinConsulta(URL_CON_NUMERO)).toBe('https://api.zavu.dev/v1/contacts');
    expect(urlSinConsulta(`https://api.zavu.dev/v1/contacts?search=${NUMERO}#x`)).toBe(
      'https://api.zavu.dev/v1/contacts',
    );
    expect(urlSinConsulta('https://api.zavu.dev/v1/messages')).toBe(
      'https://api.zavu.dev/v1/messages',
    );
  });

  it('una credencial en la propia URL también se va', () => {
    expect(urlSinConsulta('https://usuario:clave@api.zavu.dev/v1/contacts')).not.toContain('clave');
  });

  it('lo que no es una cadena se redacta en vez de adivinarse', () => {
    expect(urlSinConsulta(undefined)).toBe('[REDACTADO]');
    expect(urlSinConsulta({ url: URL_CON_NUMERO })).toBe('[REDACTADO]');
  });
});

describe('el span del `fetch` saliente', () => {
  it('pisa `url.full` y vacía `url.query`', () => {
    // Se monta el gancho tal como lo recibe la instrumentación: un `span` con
    // `setAttribute` y el `request` de undici (origin + path).
    const atributos: Record<string, unknown> = {
      // Lo que la instrumentación ya escribió antes de llamar al gancho.
      'url.full': URL_CON_NUMERO,
      'url.query': `?phoneNumber=%2B${NUMERO}`,
    };
    const span = {
      setAttribute(clave: string, valor: unknown) {
        atributos[clave] = valor;
        return this;
      },
    };
    instrumentacionUndiciSinConsulta.requestHook(span as never, {
      origin: 'https://api.zavu.dev',
      path: `/v1/contacts?phoneNumber=%2B${NUMERO}`,
    });

    expect(atributos['url.full']).toBe('https://api.zavu.dev/v1/contacts');
    expect(atributos['url.query']).toBe('');
    // La afirmación que importa, escrita como la leería alguien que audita:
    // ningún atributo del span lleva el número.
    expect(JSON.stringify(atributos)).not.toContain(NUMERO);
  });
});

describe('el breadcrumb de Sentry', () => {
  it('se queda sin `http.query` ni `http.fragment`', () => {
    const limpio = breadcrumbSinConsulta({
      data: {
        url: 'https://api.zavu.dev/v1/contacts',
        'http.method': 'GET',
        'http.query': `?phoneNumber=%2B${NUMERO}`,
        'http.fragment': '#x',
        status_code: 200,
      },
    });
    expect(limpio.data).toEqual({
      url: 'https://api.zavu.dev/v1/contacts',
      'http.method': 'GET',
      status_code: 200,
    });
    expect(JSON.stringify(limpio)).not.toContain(NUMERO);
  });

  it('una `url` que sí trae la consulta también se corta', () => {
    const limpio = breadcrumbSinConsulta({ data: { url: URL_CON_NUMERO } });
    expect(limpio.data?.url).toBe('https://api.zavu.dev/v1/contacts');
  });

  it('un breadcrumb sin datos pasa igual', () => {
    expect(breadcrumbSinConsulta(null)).toBeNull();
    expect(breadcrumbSinConsulta({})).toEqual({});
  });
});

describe('los dos caminos de salida quedan cableados', () => {
  it('`initObservability` pone el gancho de undici y el de los breadcrumbs', () => {
    // Guarda de FUENTE: la pregunta es «¿está escrito?». Las dos fugas eran
    // VALORES POR DEFECTO de librerías de terceros, así que no se ven leyendo
    // el código del llamador y vuelven solas si alguien borra una línea de
    // configuración.
    const fuente = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8');
    expect(fuente).toContain("'@opentelemetry/instrumentation-undici': instrumentacionUndiciSinConsulta");
    expect(fuente).toContain('beforeBreadcrumb');
    expect(fuente).toContain('sendDefaultPii: false');
  });
});
