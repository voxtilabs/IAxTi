import { describe, expect, it } from 'vitest';
import { ejecutarHerramienta } from '../application/herramientas';

/**
 * Quién es quien escribe y qué le pasó antes (#440).
 *
 * `crm.find_contact` y `crm.get_history` estaban DECLARADAS en el
 * manifiesto de crm desde el principio y no las implementaba nadie, así que
 * se filtraban en silencio: el asistente volvía a preguntar lo que el
 * negocio ya sabía.
 */
const base = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  actorUserId: '22222222-2222-4222-8222-222222222222',
  conversationId: '33333333-3333-4333-8333-333333333333',
};
const cliente = { query: async () => ({ rows: [], rowCount: 0 }) } as never;

const deps = (over: Record<string, unknown> = {}) => ({
  actorPuede: () => true,
  habilitadas: ['crm.find_contact', 'crm.get_history'],
  getContext: async () => ({}),
  buscarConocimiento: async () => ({}),
  buscarProducto: async () => ({}),
  ...over,
});

describe('buscar a quien escribe', () => {
  it('sin el módulo de clientes, lo dice en vez de fallar raro', async () => {
    const r = await ejecutarHerramienta(
      cliente,
      { ...base, tool: 'crm.find_contact', args: { query: 'Ana' } },
      deps() as never,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain('no está disponible');
  });

  it('sin a quién buscar, lo pide', async () => {
    const r = await ejecutarHerramienta(
      cliente,
      { ...base, tool: 'crm.find_contact', args: {} },
      deps({ buscarContacto: async () => [] }) as never,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Falta a quién buscar');
  });

  it('busca con lo que el cliente dijo de sí mismo', async () => {
    let buscado: string | null = null;
    const r = await ejecutarHerramienta(
      cliente,
      { ...base, tool: 'crm.find_contact', args: { query: '+56 9 1234 5678' } },
      deps({
        buscarContacto: async (q: string) => {
          buscado = q;
          return [{ contactId: 'c1', nombre: 'Ana' }];
        },
      }) as never,
    );
    expect(r.ok).toBe(true);
    expect(buscado).toBe('+56 9 1234 5678');
  });
});

describe('el historial', () => {
  it('es el de ESTA conversación, no el de quien el modelo nombre', async () => {
    // Dejar que el modelo elija el contacto sería pedirle el historial de
    // otra persona con forma de herramienta.
    let pedido: string | null = null;
    const r = await ejecutarHerramienta(
      cliente,
      { ...base, tool: 'crm.get_history', args: { contactId: 'el-de-otra-persona' } },
      deps({
        contactoDeLaConversacion: async () => 'el-de-esta-conversacion',
        historialDelContacto: async (id: string) => {
          pedido = id;
          return { oportunidades: [] };
        },
      }) as never,
    );
    expect(r.ok).toBe(true);
    expect(pedido).toBe('el-de-esta-conversacion');
    expect(pedido).not.toBe('el-de-otra-persona');
  });

  it('sin ficha asociada lo dice, y no inventa una', async () => {
    const r = await ejecutarHerramienta(
      cliente,
      { ...base, tool: 'crm.get_history', args: {} },
      deps({
        contactoDeLaConversacion: async () => null,
        historialDelContacto: async () => ({}),
      }) as never,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ficha');
  });
});
