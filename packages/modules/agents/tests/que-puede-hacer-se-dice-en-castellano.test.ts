import { describe, expect, it } from 'vitest';
import {
  CATALOGO_PARA_EL_DUENO,
  sirveParaEseAsistente,
} from '../domain/catalogo-para-el-dueno';
import {
  HERRAMIENTAS_DE_LECTURA,
  HERRAMIENTAS_QUE_ESCRIBEN_HABILITADAS,
} from '../application/herramientas';

/**
 * Lo que el asistente puede hacer, dicho para el dueño (#1285).
 *
 * El trinquete: una herramienta que se habilita y no tiene rótulo saldría en
 * la pantalla con su nombre técnico —`crm.create_activity`—, que no le dice
 * nada a quien tiene que decidir si se la da a su asistente. Y pasaría sin
 * que nadie se entere: la pantalla no falla, solo queda fea e inútil.
 */
const HABILITADAS = [
  ...Object.keys(HERRAMIENTAS_DE_LECTURA),
  ...Object.keys(HERRAMIENTAS_QUE_ESCRIBEN_HABILITADAS),
];

describe('qué puede hacer el asistente, en castellano (#1285)', () => {
  it('toda herramienta habilitada tiene rótulo', () => {
    const sinRotulo = HABILITADAS.filter((t) => !CATALOGO_PARA_EL_DUENO[t]);
    expect(
      sinRotulo,
      'Estas se le ofrecen al modelo y no tienen cómo mostrarse al dueño.\n' +
        'Escribí su rótulo en CATALOGO_PARA_EL_DUENO: imperativo, sin jerga, y\n' +
        'diciendo con quién habla el asistente que puede usarla.',
    ).toEqual([]);
  });

  it('y ningún rótulo sobra: no se describe una herramienta que no está habilitada', () => {
    // La otra mitad. Un rótulo de una herramienta cerrada se le ofrecería al
    // dueño para después no hacer nada, que es peor que no ofrecerla.
    const sobrantes = Object.keys(CATALOGO_PARA_EL_DUENO).filter(
      (t) => !HABILITADAS.includes(t),
    );
    expect(sobrantes, `rótulos de herramientas que no están habilitadas: ${sobrantes.join(', ')}`).toEqual([]);
  });

  it('el rótulo no es el nombre técnico disfrazado', () => {
    for (const [nombre, d] of Object.entries(CATALOGO_PARA_EL_DUENO)) {
      expect(d.rotulo, `${nombre} muestra su nombre técnico`).not.toContain('.');
      expect(d.rotulo, `${nombre} muestra su nombre técnico`).not.toContain('_');
      // Una palabra no alcanza para decir qué hace.
      expect(d.rotulo.split(/\s+/).length, `${nombre} dice muy poco`).toBeGreaterThan(2);
    }
  });

  /**
   * Y la que importa: esta pantalla NO puede reabrir el agujero de la #410.
   *
   * El copiloto llegó a tomar el asistente de estadísticas para contestarle a
   * un cliente por WhatsApp, con las métricas del negocio colgadas.
   * `atiendeClientes()` cerró esa puerta por el lado del asistente. Si la
   * pantalla ofreciera `analytics.*` a un asistente de clientes, la volvería a
   * abrir por el lado de la configuración: una casilla y el bot lee la
   * facturación.
   */
  it('las cifras del negocio no se le ofrecen a un asistente que atiende clientes', () => {
    for (const nombre of HABILITADAS.filter((t) => t.startsWith('analytics.'))) {
      expect(CATALOGO_PARA_EL_DUENO[nombre]?.paraQuien, nombre).toBe('dueño');
      expect(sirveParaEseAsistente(nombre, 'cliente'), nombre).toBe(false);
      expect(sirveParaEseAsistente(nombre, 'dueño'), nombre).toBe(true);
    }
  });

  it('tomar y mover una hora son del asistente del cliente, no del dueño', () => {
    for (const nombre of ['calendar.book', 'calendar.reschedule']) {
      expect(sirveParaEseAsistente(nombre, 'cliente'), nombre).toBe(true);
      expect(sirveParaEseAsistente(nombre, 'dueño'), nombre).toBe(false);
    }
  });

  it('una herramienta sin rótulo no se ofrece a nadie', () => {
    // Cierra por seguridad: si el trinquete de arriba alguna vez se salta,
    // lo que pasa es que no se ofrece, no que se ofrece sin nombre.
    expect(sirveParaEseAsistente('algo.que.no.existe', 'cliente')).toBe(false);
    expect(sirveParaEseAsistente('algo.que.no.existe', 'dueño')).toBe(false);
  });
});
