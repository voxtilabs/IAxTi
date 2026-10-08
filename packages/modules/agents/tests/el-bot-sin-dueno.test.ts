import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { herramientasExpuestas } from '../application/herramientas-expuestas';
import { HERRAMIENTAS_SIN_DUENO } from '../application/herramientas';

/**
 * El copiloto en una conversación sin dueño (#715).
 *
 * `herramientasExpuestas` hacía `if (!actorUserId) return []`, y el worker encima
 * tenía su propio `if (!dueno) return []`. Como una conversación nueva **nace sin
 * dueño** —el INSERT no pone `owner_id`— el bot contestaba el PRIMER mensaje con
 * cero herramientas: sin buscar el contacto, sin consultar el conocimiento del
 * negocio, sin mirar un precio. Solo con lo que dijera su prompt.
 *
 * Estaba ciego exactamente en el mensaje que más importa, y se volvía útil cuando
 * alguien asignaba la conversación — que es cuando ya hay una persona atendiendo y
 * el copiloto importa menos.
 *
 * Lo que estas pruebas cuidan es el equilibrio: que tenga lo del NEGOCIO, y que no
 * se le cuele nada de una persona.
 */
const cliente = {} as PoolClient;

const TODAS = [
  'knowledge.search',
  'knowledge.get_product',
  'conversations.get_context',
  'analytics.metrica',
  'calendar.get_slots',
  'crm.create_task',
];

function deps(extra: Record<string, unknown> = {}) {
  return {
    actorPuede: vi.fn(async () => true),
    habilitadas: TODAS,
    getContext: vi.fn(async () => ({})),
    buscarConocimiento: vi.fn(async () => [{ texto: 'El despacho cuesta 3.000' }]),
    buscarProducto: vi.fn(async () => ({ nombre: 'Depto 2D', precio: 3500 })),
    ...extra,
  } as never;
}

describe('una conversación SIN dueño (#715)', () => {
  it('ya no se queda sin herramientas: tiene las del negocio', () => {
    // Ésta es la propiedad. Antes esto devolvía [].
    const h = herramientasExpuestas(
      cliente,
      { tenantId: 't1', habilitadas: TODAS, actorUserId: null, agentId: 'a1' },
      deps(),
    );
    expect(h.length).toBeGreaterThan(0);
    expect(h.map((x) => x.name).sort()).toEqual(['knowledge.get_product', 'knowledge.search']);
  });

  it('y NO se le cuela nada que lea datos de una persona o de un contacto', () => {
    // `conversations.get_context` son los mensajes de un contacto;
    // `analytics.metrica` es «un vendedor ve lo suyo, no lo del equipo»;
    // `crm.create_task` escribe. Ninguna puede aparecer sin dueño.
    const nombres = herramientasExpuestas(
      cliente,
      { tenantId: 't1', habilitadas: TODAS, actorUserId: null, agentId: 'a1' },
      deps(),
    ).map((x) => x.name);
    for (const prohibida of [
      'conversations.get_context',
      'analytics.metrica',
      'calendar.get_slots',
      'crm.create_task',
    ]) {
      expect(nombres, `${prohibida} no puede estar sin dueño`).not.toContain(prohibida);
    }
  });

  it('que no haya dueño no agranda lo que el negocio configuró', () => {
    // Si el agente solo tiene habilitada una, sin dueño tiene esa una y no las
    // dos. La falta de dueño nunca puede dar MÁS de lo configurado.
    const h = herramientasExpuestas(
      cliente,
      { tenantId: 't1', habilitadas: ['knowledge.search'], actorUserId: null, agentId: 'a1' },
      deps({ habilitadas: ['knowledge.search'] }),
    );
    expect(h.map((x) => x.name)).toEqual(['knowledge.search']);
  });

  it('la lista sin dueño solo contiene lecturas del negocio', () => {
    // El criterio para entrar está escrito junto a la lista. Esta prueba lo fija:
    // todo lo que esté ahí tiene que pedir un permiso de lectura del negocio, no
    // uno sobre contactos, conversaciones ni reportes.
    for (const [tool, permiso] of Object.entries(HERRAMIENTAS_SIN_DUENO)) {
      expect(permiso, `${tool} pide un permiso que no es del negocio`).toBe('knowledge.read');
    }
  });

  it('con dueño sigue funcionando igual que antes', () => {
    const nombres = herramientasExpuestas(
      cliente,
      { tenantId: 't1', habilitadas: TODAS, actorUserId: 'u1', agentId: 'a1' },
      deps(),
    ).map((x) => x.name);
    expect(nombres).toContain('conversations.get_context');
    expect(nombres).toContain('knowledge.search');
  });
});
