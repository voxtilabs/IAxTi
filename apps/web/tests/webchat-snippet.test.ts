import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// El snippet corre en el sitio DEL CLIENTE (#46). Un error nuestro no rompe
// nuestra app: rompe su página. Como no hay navegador acá, se ejecuta contra
// un DOM mínimo de mentira — alcanza para las cuatro formas en que esto
// puede arruinarle la vida a alguien.

const SNIPPET = readFileSync(join(__dirname, '../public/webchat.js'), 'utf8');

interface ElementoFalso {
  tag: string;
  type?: string;
  src?: string;
  title?: string;
  textContent?: string;
  style: { cssText: string; display?: string };
  attrs: Record<string, string>;
  setAttribute(n: string, v: string): void;
  getAttribute(n: string): string | null;
  addEventListener(evento: string, fn: () => void): void;
  click(): void;
}

function elemento(tag: string): ElementoFalso {
  const oyentes: Array<() => void> = [];
  return {
    tag,
    style: { cssText: '' },
    attrs: {},
    setAttribute(n, v) {
      this.attrs[n] = v;
    },
    getAttribute(n) {
      return this.attrs[n] ?? null;
    },
    addEventListener(_evento, fn) {
      oyentes.push(fn);
    },
    click() {
      for (const fn of oyentes) fn();
    },
  };
}

function correr(opciones: { conBody?: boolean; widget?: string | null; href?: string } = {}) {
  const creados: ElementoFalso[] = [];
  const montados: ElementoFalso[] = [];
  const pendientes: Record<string, Array<() => void>> = {};
  const body = opciones.conBody === false ? null : { appendChild: (el: ElementoFalso) => montados.push(el) };

  const documento = {
    currentScript: {
      src: 'https://app.iaxti.cl/webchat.js',
      getAttribute: (n: string) =>
        n === 'data-widget' ? (opciones.widget === undefined ? 'wgt_123' : opciones.widget) : null,
    },
    createElement: (tag: string) => {
      const el = elemento(tag);
      creados.push(el);
      return el;
    },
    get body() {
      return body;
    },
    addEventListener: (evento: string, fn: () => void) => {
      (pendientes[evento] ??= []).push(fn);
    },
  };

  const ventana: Record<string, unknown> = {
    location: { href: opciones.href ?? 'https://tienda.cl/productos/zapatos' },
  };
  const fn = new Function('window', 'document', 'URL', 'encodeURIComponent', SNIPPET);
  fn(ventana, documento, URL, encodeURIComponent);
  return { creados, montados, ventana, dispararDomListo: () => (pendientes.DOMContentLoaded ?? []).forEach((f) => f()) };
}

describe('el widget en el sitio de un tercero', () => {
  it('no carga el chat hasta que alguien lo abre', () => {
    const { creados, montados } = correr();
    // Antes se creaba el iframe en CADA visita aunque nadie lo abriera:
    // ancho de banda del cliente y una sesión de alguien que solo pasaba.
    expect(creados.filter((e) => e.tag === 'iframe')).toHaveLength(0);
    expect(montados.map((e) => e.tag)).toEqual(['button']);

    montados[0].click();
    const iframes = creados.filter((e) => e.tag === 'iframe');
    expect(iframes).toHaveLength(1);
    expect(iframes[0].style.display).toBe('block');
  });

  it('NO manda el query de la página: ahí viven correos y tokens del sitio', () => {
    const { montados, creados } = correr({
      href: 'https://tienda.cl/carro?email=ana@correo.cl&token=abc123#pago',
    });
    montados[0].click();
    const src = creados.find((e) => e.tag === 'iframe')!.src!;
    expect(decodeURIComponent(src)).toContain('https://tienda.cl/carro');
    expect(src).not.toMatch(/ana%40correo|email|token|abc123/);
  });

  it('con el script en el <head> espera al body en vez de reventar', () => {
    // `async` + <head> = el snippet corre antes de que exista <body>, y
    // `document.body.appendChild` sobre null es un TypeError en la consola
    // del sitio del cliente. Que no reviente es la mitad; la otra mitad es
    // que el botón SÍ aparezca cuando el body llega.
    const montadosTarde: ElementoFalso[] = [];
    const pendientes: Array<() => void> = [];
    let body: { appendChild: (el: ElementoFalso) => void } | null = null;
    const documento = {
      currentScript: {
        src: 'https://app.iaxti.cl/webchat.js',
        getAttribute: () => 'wgt_123',
      },
      createElement: elemento,
      get body() {
        return body;
      },
      addEventListener: (_e: string, fn: () => void) => pendientes.push(fn),
    };
    const fn = new Function('window', 'document', 'URL', 'encodeURIComponent', SNIPPET);
    expect(() =>
      fn({ location: { href: 'https://tienda.cl/' } }, documento, URL, encodeURIComponent),
    ).not.toThrow();
    expect(montadosTarde).toHaveLength(0);

    // Llega el body y se dispara DOMContentLoaded: ahora sí monta.
    body = { appendChild: (el: ElementoFalso) => montadosTarde.push(el) };
    for (const f of pendientes) f();
    expect(montadosTarde.map((e) => e.tag)).toEqual(['button']);
  });

  it('pegado dos veces pinta UN solo botón', () => {
    // Pasa siempre: gestor de etiquetas más pegado a mano.
    const ventanaCompartida: Record<string, unknown> = {};
    const montados: ElementoFalso[] = [];
    const documento = {
      currentScript: {
        src: 'https://app.iaxti.cl/webchat.js',
        getAttribute: () => 'wgt_123',
      },
      createElement: elemento,
      body: { appendChild: (el: ElementoFalso) => montados.push(el) },
      addEventListener: () => undefined,
    };
    ventanaCompartida.location = { href: 'https://tienda.cl/' };
    const fn = new Function('window', 'document', 'URL', 'encodeURIComponent', SNIPPET);
    fn(ventanaCompartida, documento, URL, encodeURIComponent);
    fn(ventanaCompartida, documento, URL, encodeURIComponent);
    expect(montados).toHaveLength(1);
  });

  it('sin data-widget no hace nada, en vez de fallar a medias', () => {
    const { montados } = correr({ widget: null });
    expect(montados).toHaveLength(0);
  });
});
