// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VistaDelAgente } from '../components/agente/vistas';

/**
 * La vista del agente (#1380), montada y no leída (#564): lo que se prueba es
 * qué se VE. La validación ya la probó el módulo con su propia suite; acá lo
 * que importa es el dibujo — que los cinco componentes lleguen a pantalla, que
 * el teléfono vaya en mono y que una vista manipulada en el localStorage del
 * hilo desaparezca sin llevarse la conversación.
 */

/** Una vista con los CINCO componentes: si alguno falta en el renderer,
 * `createRenderer` revienta y esta prueba lo caza. Es la guarda de deriva
 * entre el catálogo del módulo y el dibujo de la web, dicho en comportamiento. */
const COMPLETA = {
  root: 'z',
  elements: {
    // Los cinco cuelgan de la Zona: el renderer solo dibuja lo que es
    // alcanzable desde la raíz, y un huérfano no prueba nada.
    z: { type: 'Zona', props: { titulo: 'Cómo va la bandeja' }, children: ['t', 'm', 'tj', 'e'] },
    t: {
      type: 'Tabla',
      props: {
        columnas: ['Contacto', 'Teléfono'],
        filas: [['María Paz', '+56 9 1234 5678']],
        mono: [false, true],
      },
    },
    m: { type: 'Metrica', props: { rotulo: 'Por contestar', valor: 2 } },
    tj: { type: 'Tarjeta', props: { titulo: 'Nota', texto: 'El horario cierra a las 21:00.' } },
    e: { type: 'Etiqueta', props: { texto: 'Ventana abierta', tono: 'good' } },
  },
};

describe('la vista del agente', () => {
  it('dibuja los cinco componentes del catálogo', () => {
    render(<VistaDelAgente vista={COMPLETA} />);
    expect(screen.getByText('Cómo va la bandeja')).toBeTruthy();
    expect(screen.getByText('María Paz')).toBeTruthy();
    expect(screen.getByText('Por contestar')).toBeTruthy();
    expect(screen.getByText('Ventana abierta')).toBeTruthy();
    expect(screen.getByText('El horario cierra a las 21:00.')).toBeTruthy();
  });

  it('la columna que el modelo marcó como teléfono se dibuja en mono', () => {
    render(<VistaDelAgente vista={COMPLETA} />);
    const telefono = screen.getByText('+56 9 1234 5678');
    expect(telefono.className).toContain('font-mono');
    // Y la que no: prosa normal, que la firma no se repita donde no va.
    expect(screen.getByText('María Paz').className).not.toContain('font-mono');
  });

  it('una vista editada a mano en el hilo desaparece, y la conversación sigue', () => {
    const manipulada = {
      ...COMPLETA,
      elements: {
        ...COMPLETA.elements,
        m: { type: 'Metrica', props: { rotulo: 'x', valor: { $state: '/algo' } } },
      },
    };
    const { container } = render(<VistaDelAgente vista={manipulada} />);
    expect(container.innerHTML).toBe('');
  });

  it('un componente que la web nunca registró tampoco se dibuja', () => {
    const { container } = render(
      <VistaDelAgente vista={{ root: 'v', elements: { v: { type: 'Boton', props: { texto: 'Borrar todo' } } } }} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('sin vista no hay bloque: el turno queda solo con su prosa', () => {
    const { container } = render(<VistaDelAgente vista={null} />);
    expect(container.innerHTML).toBe('');
  });
});
