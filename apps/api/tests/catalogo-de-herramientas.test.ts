import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/main';
import {
  CATALOGO,
  herramientasPara,
  nombreDeHerramienta,
  tratoDe,
} from '../../../packages/modules/agents/application/catalogo';
import {
  NO_SON_HERRAMIENTA,
  SIN_CONFIRMACION,
} from '../../../packages/modules/agents/application/catalogo-curado';

/**
 * El catálogo de herramientas contra la API REAL (#492, ADR-0025).
 *
 * Todo el Agente General se apoya en que este catálogo esté completo y al
 * día. Si se atrasa, pasa lo de siempre en este repo —función construida,
 * sin puerta— solo que ahora la puerta que falta es la del agente y nadie
 * la ve faltar: el modelo simplemente no ofrece lo que no conoce.
 *
 * Por eso esto levanta la app DE VERDAD y compara contra su documento
 * OpenAPI, en vez de mirar una copia escrita a mano.
 */
const RAIZ = join(__dirname, '..', '..', '..');

let app: INestApplication;
let documento: {
  paths: Record<string, Record<string, { operationId?: string; summary?: string } & Record<string, unknown>>>;
};
let operacionesReales: Array<{ operationId: string; metodo: string; ruta: string; permiso?: string; modulo?: string; auth?: string }>;

beforeAll(async () => {
  app = await createApp();
  await app.listen(0);
  documento = await (await fetch(`${await app.getUrl()}/docs-json`)).json();
  // Los esquemas de cuerpo (#524) no salen del OpenAPI: Nest no publica la
  // forma del cuerpo, así que el decorador `@Cuerpo` los registra al
  // declararse y el volcado los agrega como extensión. Acá se agregan igual
  // que en `dump-openapi.mjs` — si no, el test compararía el catálogo real
  // contra uno sin argumentos y diría que está viejo cuando no lo está.
  const { ESQUEMAS_DE_CUERPO } = await import('../src/validar');
  (documento as Record<string, unknown>)['x-iaxti-cuerpos'] = Object.fromEntries(ESQUEMAS_DE_CUERPO);
  operacionesReales = Object.entries(documento.paths).flatMap(([ruta, metodos]) =>
    Object.entries(metodos)
      .filter(([, op]) => op.operationId)
      .map(([metodo, op]) => ({
        operationId: op.operationId as string,
        metodo: metodo.toUpperCase(),
        ruta,
        permiso: op['x-iaxti-permission'] as string | undefined,
        modulo: op['x-iaxti-module'] as string | undefined,
        auth: op['x-iaxti-auth'] as string | undefined,
      })),
  );
}, 60_000);

afterAll(async () => {
  await app?.close();
});

describe('el catálogo cubre la API entera', () => {
  it('toda operación es herramienta, o dice por qué no', () => {
    const faltan = operacionesReales
      .filter((o) => !(o.operationId in NO_SON_HERRAMIENTA))
      .filter((o) => !CATALOGO.some((h) => h.operationId === o.operationId))
      .map((o) => `${o.metodo} ${o.ruta} (${o.operationId})`);
    expect(
      faltan,
      'Estas operaciones existen en la API y el Agente General no las conoce. Regenera el ' +
        'catálogo (`node scripts/generar-catalogo-herramientas.mjs`) o escribe en ' +
        'NO_SON_HERRAMIENTA por qué no debe serlo:\n  ' + faltan.join('\n  '),
    ).toEqual([]);
  });

  it('el catálogo no inventa operaciones que ya no existen', () => {
    // Una herramienta que apunta a una ruta borrada le hace perder un turno
    // al modelo con un 404 que no sabe interpretar.
    const reales = new Set(operacionesReales.map((o) => o.operationId));
    const fantasmas = CATALOGO.filter((h) => !reales.has(h.operationId)).map((h) => h.nombre);
    expect(fantasmas, 'Sobran en el catálogo: regenéralo').toEqual([]);
  });

  it('la ruta, el verbo y el permiso son los de la API, no una copia', () => {
    for (const h of CATALOGO) {
      const real = operacionesReales.find((o) => o.operationId === h.operationId)!;
      expect(`${h.metodo} ${h.ruta}`, h.nombre).toBe(`${real.metodo} ${real.ruta}`);
      expect(h.permiso, h.nombre).toBe(real.permiso ?? null);
      expect(h.modulo, h.nombre).toBe(real.modulo ?? null);
    }
  });

  it('el archivo generado está al día con el código', async () => {
    // Regenerar en memoria y comparar: si alguien tocó un controlador y no
    // regeneró, el catálogo miente a partir de ese commit.
    const { construirCatalogo, textoDelArchivo } = await import(
      join(RAIZ, 'scripts/generar-catalogo-herramientas.mjs')
    );
    const esperado = textoDelArchivo(construirCatalogo(documento));
    const actual = readFileSync(
      join(RAIZ, 'packages/modules/agents/application/catalogo.generated.ts'),
      'utf8',
    );
    expect(
      actual,
      'El catálogo generado quedó viejo. Corre:\n' +
        '  node scripts/dump-openapi.mjs /tmp/openapi.json && node scripts/generar-catalogo-herramientas.mjs /tmp/openapi.json',
    ).toBe(esperado);
  }, 60_000);
});

describe('lo peligroso no entra sin decisión escrita', () => {
  it('ningún webhook ni simulador es herramienta', () => {
    // Serían la misma puerta: fabricar mensajes de clientes que nunca
    // escribieron, o dar por pagado lo que nadie pagó.
    const peligrosas = CATALOGO.filter(
      (h) => h.ruta.startsWith('/webhooks/') || h.ruta.startsWith('/webchat/') || h.ruta.includes('/dev/'),
    ).map((h) => h.nombre);
    expect(peligrosas).toEqual([]);
  });

  it('toda herramienta exige un permiso', () => {
    // Sin permiso no hay cómo filtrar por quién habla, y "la IA no puede
    // hacer lo que la persona no podría" dejaría de significar algo.
    const sinPermiso = CATALOGO.filter((h) => h.permiso === null).map(
      (h) => `${h.nombre} (${h.metodo} ${h.ruta})`,
    );
    expect(
      sinPermiso,
      'Estas herramientas no exigen permiso: o se les pone uno en la API, o van a ' +
        'NO_SON_HERRAMIENTA con su motivo:\n  ' + sinPermiso.join('\n  '),
    ).toEqual([]);
  });

  it('cada excepción explica POR QUÉ, no solo que no va', () => {
    for (const [op, motivo] of Object.entries(NO_SON_HERRAMIENTA)) {
      expect(motivo.length, `"${op}" sin explicar`).toBeGreaterThan(25);
    }
  });

  it('la lista de excepciones no junta polvo', () => {
    const reales = new Set(operacionesReales.map((o) => o.operationId));
    const fantasmas = Object.keys(NO_SON_HERRAMIENTA).filter((op) => !reales.has(op));
    expect(fantasmas, 'Ya no existen: sácalas de NO_SON_HERRAMIENTA').toEqual([]);
  });

  it('lo que se salta la confirmación existe y no es un GET', () => {
    // Un nombre viejo ahí adentro es una autorización que nadie revisó: si
    // mañana aparece una operación con ese operationId, nace libre.
    const reales = new Set(operacionesReales.map((o) => o.operationId));
    const fantasmas = [...SIN_CONFIRMACION].filter((op) => !reales.has(op));
    expect(fantasmas, 'Ya no existen: sácalas de SIN_CONFIRMACION').toEqual([]);
    for (const op of SIN_CONFIRMACION) {
      const real = operacionesReales.find((o) => o.operationId === op);
      expect(real?.metodo, `${op} es GET: ya era libre, sobra en la lista`).not.toBe('GET');
    }
  });
});

describe('el trato por defecto es pedir permiso', () => {
  it('una escritura desconocida nace pidiendo confirmación', () => {
    expect(tratoDe('OperacionNuevaController_crear', 'POST')).toBe('confirmar');
    expect(tratoDe('OperacionNuevaController_borrar', 'DELETE')).toBe('confirmar');
  });

  it('leer es libre', () => {
    expect(tratoDe('LoQueSeaController_list', 'GET')).toBe('libre');
  });

  it('borrar JAMÁS es libre, aunque alguien lo escriba en la lista', () => {
    // La lista es de escrituras reversibles; un DELETE no lo es nunca.
    for (const op of SIN_CONFIRMACION) {
      const real = operacionesReales.find((o) => o.operationId === op);
      expect(real?.metodo, `${op} borra: no puede saltarse la confirmación`).not.toBe('DELETE');
    }
  });

  it('cancelar la suscripción confirma', () => {
    const cancelar = CATALOGO.find((h) => h.ruta === '/v1/billing/cancelar');
    expect(cancelar?.trato).toBe('confirmar');
  });
});

describe('las herramientas se filtran por quien habla', () => {
  it('sin el permiso, la herramienta ni se ofrece', () => {
    const modulos = new Set(CATALOGO.map((h) => h.modulo).filter(Boolean) as string[]);
    const soloContactos = herramientasPara({
      permisos: new Set(['crm.contacts.read']),
      modulosActivos: modulos,
    });
    expect(soloContactos.length).toBeGreaterThan(0);
    expect(soloContactos.every((h) => h.permiso === 'crm.contacts.read')).toBe(true);
  });

  it('con el módulo apagado, tampoco', () => {
    const permisos = new Set(CATALOGO.map((h) => h.permiso).filter(Boolean) as string[]);
    const sinCrm = herramientasPara({
      permisos,
      modulosActivos: new Set(
        [...new Set(CATALOGO.map((h) => h.modulo).filter(Boolean) as string[])].filter((m) => m !== 'crm'),
      ),
    });
    expect(sinCrm.some((h) => h.modulo === 'crm')).toBe(false);
  });

  it('el dueño con todo encendido ve la API entera menos lo excluido', () => {
    const todo = herramientasPara({
      permisos: new Set(CATALOGO.map((h) => h.permiso).filter(Boolean) as string[]),
      modulosActivos: new Set(CATALOGO.map((h) => h.modulo).filter(Boolean) as string[]),
    });
    expect(todo.length).toBe(CATALOGO.length);
    // Y son muchas: si esto baja de golpe, algo dejó de generarse.
    expect(todo.length).toBeGreaterThan(150);
  });
});

describe('los nombres son para el modelo, no para el compilador', () => {
  it('salen del operationId, sin diccionario a mano', () => {
    expect(nombreDeHerramienta('ContactsController_actualizar')).toBe('contacts.actualizar');
    expect(nombreDeHerramienta('AgendaController_huecos')).toBe('agenda.huecos');
  });

  it('no se repiten', () => {
    const vistos = new Set<string>();
    const repetidos = CATALOGO.filter((h) => !vistos.add(h.nombre)).map((h) => h.nombre);
    expect(repetidos, 'Dos herramientas con el mismo nombre: el modelo no puede elegir').toEqual([]);
  });

  it('toda herramienta tiene descripción', () => {
    // Sin descripción el modelo elige por el nombre, y el nombre está
    // pensado para ser corto, no para explicar.
    const mudas = CATALOGO.filter((h) => !h.descripcion.trim()).map((h) => h.nombre);
    expect(mudas, 'Sin descripción: ponle @ApiOperation summary al endpoint').toEqual([]);
  });
});
