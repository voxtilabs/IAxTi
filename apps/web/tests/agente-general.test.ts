import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * IAxTi presente en toda la app (#493, ADR-0025).
 *
 * El popup no es una pantalla más: es la vía de configuración. Por eso vive
 * en la barra del shell y no en una ruta suya — configurar conversando solo
 * sirve si está donde estás.
 */
const AGENTE = readFileSync(join(__dirname, '..', 'components', 'agente-general.tsx'), 'utf8');
const SHELL = readFileSync(join(__dirname, '..', 'components', 'app-shell.tsx'), 'utf8');

describe('está presente en toda la app', () => {
  it('vive en la barra del shell, no en una pantalla', () => {
    expect(SHELL).toContain('<AgenteGeneral />');
  });

  it('va antes de buscar: pedir es lo que se hace más seguido', () => {
    expect(SHELL.indexOf('<AgenteGeneral />')).toBeLessThan(SHELL.indexOf('<PaletaComandos'));
  });

  it('se abre con un atajo desde cualquier pantalla', () => {
    expect(AGENTE).toContain("aria-keyshortcuts=\"Control+i Meta+i\"");
    expect(AGENTE).toMatch(/e\.key\.toLowerCase\(\) === 'i'/);
  });
});

describe('los componentes son los de siempre, no unos nuevos', () => {
  it('la conversación son los AI Elements del AI SDK', () => {
    // Traerlos hechos evita el clásico: el auto-scroll que se pega cuando
    // el usuario está leyendo más arriba.
    for (const c of ['Conversation', 'ConversationContent', 'ConversationScrollButton', 'Message', 'MessageContent', 'Loader']) {
      expect(AGENTE, c).toContain(c);
    }
  });

  it('el popup es el Dialog de shadcn que ya usa la paleta', () => {
    expect(AGENTE).toContain('DialogContent');
  });
});

describe('lo irreversible se aprueba, no se ejecuta solo', () => {
  it('la propuesta se muestra con sus datos', () => {
    expect(AGENTE).toContain('propuesta.argumentos');
    expect(AGENTE).toContain('Necesito tu visto bueno');
  });

  it('aplicar pasa por su propia puerta', () => {
    expect(AGENTE).toContain("'/agente-general/aplicar'");
  });

  it('descartar no llama a nada', () => {
    const i = AGENTE.indexOf('if (!aplicar)');
    expect(i).toBeGreaterThan(0);
    expect(AGENTE.slice(i, i + 200)).toContain("resuelta: 'descartada'");
  });

  it('resuelta, la propuesta queda como registro y sin botones', () => {
    expect(AGENTE).toContain('{!resuelta && (');
  });
});

describe('el hilo', () => {
  it('al servidor solo van los turnos, no los pasos', () => {
    // Devolverle al modelo lo que él mismo generó es pagar tokens de más.
    expect(AGENTE).toContain('mios.map(({ role, content }) => ({ role, content }))');
  });

  it('cambiar de negocio corta la conversación', () => {
    // Seguirla con otro negocio sería configurarlo con el contexto ajeno.
    expect(AGENTE).toContain("window.addEventListener('iaxti-tenant-changed', cambio)");
  });

  it('una respuesta cortada se dice', () => {
    expect(AGENTE).toContain('r.truncada');
  });
});

/**
 * Varios asistentes por negocio (#494).
 *
 * Tres pantallas tomaban `agentes[0]`: el modo autónomo, las evaluaciones y
 * el logro del objetivo. Quien tenía dos configuraba siempre el primero
 * creyendo que configuraba el que estaba mirando — y el modo autónomo es el
 * ajuste donde equivocarse se nota en la cara de un cliente.
 */
const SELECTOR = readFileSync(join(__dirname, '..', 'components', 'selector-de-asistente.tsx'), 'utf8');
const MODO = readFileSync(join(__dirname, '..', 'components', 'modo-autonomo.tsx'), 'utf8');
const EVALS = readFileSync(join(__dirname, '..', 'components', 'evaluaciones.tsx'), 'utf8');
const LOGRO_MULTI = readFileSync(join(__dirname, '..', 'components', 'logro-del-objetivo.tsx'), 'utf8');

describe('varios asistentes', () => {
  it('ninguna pantalla toma el primero de la lista', () => {
    for (const [nombre, fuente] of [['modo', MODO], ['evals', EVALS], ['logro', LOGRO_MULTI]] as const) {
      expect(fuente, nombre).not.toContain('agentes[0]');
      expect(fuente, nombre).not.toContain('lista[0]');
      expect(fuente, nombre).toContain('useAsistenteElegido');
    }
  });

  it('con UNO solo el selector no se dibuja', () => {
    // Un desplegable de una opción es ruido, y ocupa el lugar donde debería
    // estar el nombre.
    expect(SELECTOR).toContain('asistentes.length < 2) return null');
  });

  it('recargar no te devuelve al primero', () => {
    // Guardar el modo autónomo y volver al asistente de arriba sería el
    // mismo bug con otro disfraz.
    expect(SELECTOR).toContain('lista.some((a) => a.id === actual)');
  });

  it('el Agente General sabe que puede crear varios, y de dónde saca los objetivos', () => {
    // Un objetivo inventado deja al asistente sin herramientas: nace y no
    // sirve para nada.
    const AG = readFileSync(
      join(__dirname, '..', '..', '..', 'packages', 'modules', 'agents', 'application', 'agente-general.ts'),
      'utf8',
    );
    expect(AG).toContain('pide la lista de objetivos y elige de ahí');
    expect(AG).toContain('No pidas el');
  });
});
