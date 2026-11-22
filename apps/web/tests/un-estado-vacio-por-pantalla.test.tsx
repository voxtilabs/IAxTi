// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Un estado vacío por pantalla, no dos que se desmienten (#1326).
 *
 * Las dos contradicciones que el issue nombró, montadas y leídas:
 *
 * 1. **Bandeja vacía**: la lista dice «no te escribe nadie» y el panel de
 *    la derecha decía «elige una conversación de la lista» — una
 *    instrucción imposible, porque no hay lista de donde elegir. Ahora el
 *    panel dice lo que corresponde a ESTE estado.
 * 2. **IA rota**: el aviso rojo dice que no puede nada y el chat de abajo
 *    invitaba a pedirle cosas con el botón habilitado. Ahora el campo no
 *    acepta texto y el botón está apagado — si no puede, no ofrece.
 *
 * Son de COMPORTAMIENTO y no de fuente porque lo que se sostiene es lo que
 * se LEE en cada estado, no que una clase exista.
 */

const contexto = vi.hoisted(() => ({
  tenant: 'negocio-a',
  config: { apiUrl: 'http://api.local' },
  session: { access_token: 'sesion-a' },
}));
vi.mock('@iaxti/ui/react', async (original) => ({
  ...(await original<typeof import('@iaxti/ui/react')>()),
  useSession: () => contexto,
}));
vi.mock('../components/tenant-switcher', () => ({
  useSelectedTenant: () => contexto.tenant,
  selectedTenant: () => contexto.tenant,
}));
/* La pantalla decide si se pide diagnóstico: solo /ajustes/ia conversa.
   usePathname va mockeado para poder estar «en» esa pantalla desde jsdom. */
const enLaPantallaDelAsistente = vi.hoisted(() => ({ ruta: '/ajustes/ia' }));
vi.mock('next/navigation', () => ({
  usePathname: () => enLaPantallaDelAsistente.ruta,
}));
vi.mock('../lib/api', async (original) => ({
  ...(await original<typeof import('../lib/api')>()),
  apiFetch: vi.fn(),
}));
import { apiFetch } from '../lib/api';
import { Chat } from '../components/bandeja/chat';
import { Conversacion } from '../components/agente/conversacion';
import { ProveedorAgente } from '../components/agente/estado';

const pedir = vi.mocked(apiFetch);

/* Radix usa APIs de puntero que jsdom no trae. */
Element.prototype.hasPointerCapture = () => false;
Element.prototype.releasePointerCapture = () => {};
Element.prototype.scrollIntoView = () => {};
/* El scroll del chat mide con ResizeObserver, que jsdom tampoco trae. */
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  (globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
}

beforeEach(() => {
  pedir.mockReset();
  pedir.mockResolvedValue([]);
});

describe('la bandeja vacía no pide elegir de una lista que no tiene nada (#1326)', () => {
  it('con la lista vacía, el panel derecho no dice «elige una conversación»', () => {
    render(
      <Chat
        detalle={null}
        listaVacia
        mensajes={null}
        atajos={[]}
        sugerencia={null}
        sinSugerencia={null}
        modo={null}
        miId="yo"
        aviso={null}
        limitesDeAdjunto={null}
        onReintentar={async () => {}}
        reintentando={null}
        plantillas={[]}
        onVolver={() => {}}
        onVerFicha={() => {}}
        onResponder={async () => true}
        onAsignar={async () => true}
        onEstado={async () => true}
        onPrioridad={async () => true}
        onSugerencia={async () => {}}
        onModo={async () => {}}
        onCobrar={async () => {}}
        onCrearOportunidad={async () => {}}
        onCargarPlantillas={async () => {}}
        onEnviarPlantilla={async () => {}}
        onAbrirAdjunto={() => {}}
      />,
    );
    // Lo que dice: el estado real.
    expect(screen.getByText('Cuando un cliente escriba, su conversación abre acá.')).toBeInTheDocument();
    // Lo que NO puede volver a decir: la instrucción imposible.
    expect(screen.queryByText('Elige una conversación de la lista para atenderla aquí.')).not.toBeInTheDocument();
  });

  it('con lista con contenido y nada elegido, la instrucción sigue siendo la de siempre', () => {
    render(
      <Chat
        detalle={null}
        listaVacia={false}
        mensajes={null}
        atajos={[]}
        sugerencia={null}
        sinSugerencia={null}
        modo={null}
        miId="yo"
        aviso={null}
        limitesDeAdjunto={null}
        onReintentar={async () => {}}
        reintentando={null}
        plantillas={[]}
        onVolver={() => {}}
        onVerFicha={() => {}}
        onResponder={async () => true}
        onAsignar={async () => true}
        onEstado={async () => true}
        onPrioridad={async () => true}
        onSugerencia={async () => {}}
        onModo={async () => {}}
        onCobrar={async () => {}}
        onCrearOportunidad={async () => {}}
        onCargarPlantillas={async () => {}}
        onEnviarPlantilla={async () => {}}
        onAbrirAdjunto={() => {}}
      />,
    );
    expect(screen.getByText('Elige una conversación de la lista para atenderla aquí.')).toBeInTheDocument();
  });
});

describe('con la IA rota, el chat no invita a pedirle cosas (#1326)', () => {
  it('el campo no acepta texto y el botón está apagado', async () => {
    const usuario = userEvent.setup();
    // El diagnóstico dice que hay problema: la IA no puede trabajar.
    pedir.mockImplementation(async (_c, _s, _t, path: string) => {
      if (path === '/agents/diagnostico') return { problema: 'proveedores', pasos: [] };
      return [];
    });
    // `useAgente` exige el proveedor; `PantallaDelAsistente` lo monta junto a
    // la señal. Acá monto lo mínimo que ejercita la regla: proveedor + chat.
    render(
      <ProveedorAgente>
        <Conversacion />
      </ProveedorAgente>,
    );
    // El campo muerto no lleva placeholder (#1326): el mensaje de qué hacer
    // lo da la señal roja, no el campo. Lo que lo identifica acá es su aria-label.
    const campo = await screen.findByLabelText('Pídele algo a IAxTi');
    // El texto NO entra (readOnly): lo que uno escriba no aparece.
    await usuario.type(campo, 'hola');
    expect(campo).toHaveValue('');
    // Y no invita: sin placeholder mientras la IA no puede.
    expect(campo).toHaveAttribute('placeholder', '');
    // El botón está apagado incluso si hubiera texto.
    expect(screen.getByRole('button', { name: 'Pedir' })).toBeDisabled();
  });

  it('con la IA sana, el campo invita y acepta como siempre', async () => {
    const usuario = userEvent.setup();
    pedir.mockImplementation(async (_c, _s, _t, path: string) => {
      if (path === '/agents/diagnostico') return { problema: null, pasos: [] };
      if (typeof path === 'string' && path.includes('sugerencias')) return { sugerencias: [] };
      return [];
    });
    render(
      <ProveedorAgente>
        <Conversacion />
      </ProveedorAgente>,
    );
    const campo = await screen.findByPlaceholderText('Pídele lo que necesitas');
    await usuario.type(campo, '¿cómo va mi negocio?');
    expect(campo).toHaveValue('¿cómo va mi negocio?');
    expect(screen.getByRole('button', { name: 'Pedir' })).toBeEnabled();
  });
});
