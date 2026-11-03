// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * Configurar el asistente desde el panel (#1230).
 *
 * Prueba de COMPORTAMIENTO y no de fuente porque las dos cosas que hay que
 * sostener acá solo se ven al usarlo:
 *
 *  1. **Que cambiar una perilla no borre las otras.** El PUT hace
 *     `limits = COALESCE($14::jsonb, limits)`: reemplaza el jsonb entero. Una
 *     escritura parcial responde 200 con el agente ya vaciado, así que el
 *     defecto no deja error en ninguna parte — lo único que lo caza es mirar
 *     el cuerpo que SALE al tocar un control.
 *  2. **Que el pulso siga naciendo apagado.** Es lo único de la pantalla que
 *     le escribe a un cliente sin que nadie apriete nada, y «nace apagado» no
 *     es una propiedad del código: es lo que pasa cuando alguien toca
 *     cualquier otro control del mismo bloque.
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
vi.mock('../components/tenant-switcher', () => ({ useSelectedTenant: () => contexto.tenant }));
vi.mock('../lib/api', async (original) => ({
  ...(await original<typeof import('../lib/api')>()),
  apiFetch: vi.fn(),
}));
import { ApiError, apiFetch } from '../lib/api';
import { ModoAutonomo } from '../components/modo-autonomo';

const pedir = vi.mocked(apiFetch);

/**
 * Lo que jsdom no trae y Radix pide para abrir un desplegable.
 *
 * Sin esto `userEvent.click` sobre el disparador muere con
 * `target.hasPointerCapture is not a function`, que no se parece en nada a su
 * causa: parece que el control no existe.
 */
beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

interface Pulso {
  activo?: boolean;
  cada_minutos?: number;
  desde?: string;
  hasta?: string;
  max_por_persona?: number;
}
interface Agente {
  id: string;
  name: string;
  active: boolean;
  personality: string | null;
  promptName: string | null;
  fallbackSystemPrompt: string | null;
  defaultMode: 'assist' | 'autonomous' | 'off';
  autonomousHours: Record<string, unknown>;
  limits: Record<string, unknown> & { pulso?: Pulso };
}

const EQUIPO = [
  { userId: 'u-sofia', nombre: 'Sofía Vargas', email: 'sofia@negocio.cl' },
  { userId: 'u-sin-nombre', nombre: null, email: 'nuevo@negocio.cl' },
];

function asistente(parcial: Partial<Agente> = {}): Agente {
  return {
    id: 'ag-jose',
    name: 'José',
    active: true,
    personality: null,
    promptName: null,
    fallbackSystemPrompt: null,
    defaultMode: 'assist',
    autonomousHours: {},
    limits: {},
    ...parcial,
  };
}

/** Los cuerpos que la pantalla mandó por PUT, en orden. */
let enviados: Array<Record<string, unknown>>;
const ultimo = () => enviados[enviados.length - 1]!;

/**
 * Monta la pantalla contra una API simulada que CONSERVA lo que se le manda.
 *
 * Que el PUT devuelva el agente ya actualizado no es un detalle del simulacro:
 * la pantalla lee los valores del agente que le devolvieron, así que si el
 * cuerpo que sale está incompleto, la pantalla lo muestra incompleto. Es la
 * mitad del defecto que esta prueba vigila.
 */
function montar(lista: Array<Partial<Agente>> = [{}], equipo: 'ok' | 'sin_permiso' = 'ok') {
  let agentes = lista.map(asistente);
  pedir.mockImplementation(async (_config, _sesion, _tenant, ruta, init) => {
    if (init?.method === 'PUT') {
      const cuerpo = JSON.parse(String(init.body)) as Record<string, unknown>;
      enviados.push(cuerpo);
      const id = ruta.replace('/agents/', '');
      agentes = agentes.map((a) => (a.id === id ? { ...a, ...cuerpo } : a));
      return agentes.find((a) => a.id === id)!;
    }
    if (ruta === '/agents') return agentes;
    if (ruta === '/equipo') {
      if (equipo === 'sin_permiso') {
        throw new ApiError('FORBIDDEN', 'No tienes permiso para ver el equipo.', 403, 'req_1');
      }
      return { miembros: EQUIPO };
    }
    throw new Error(`ruta no simulada: ${ruta}`);
  });
  return render(<ModoAutonomo />);
}

beforeEach(() => {
  enviados = [];
  pedir.mockReset();
});

describe('los límites se mandan enteros (#1230)', () => {
  it('cambiar el aviso al derivar conserva las otras cinco llaves', async () => {
    montar([
      {
        limits: {
          confidence_threshold: 0.4,
          max_agent_turns: 9,
          money_limit_clp: 50000,
          handoff_user_id: 'u-sofia',
          firma_en_cada_mensaje: false,
          pulso: { activo: true, desde: '09:00', hasta: '18:00', cada_minutos: 40, max_por_persona: 6 },
        },
      },
    ]);
    const campo = await screen.findByRole('textbox', { name: 'El aviso al derivar' });
    await userEvent.type(campo, 'Ya le avisé al equipo.');
    await userEvent.tab();

    await waitFor(() => expect(enviados).toHaveLength(1));
    expect(ultimo().limits).toEqual({
      confidence_threshold: 0.4,
      max_agent_turns: 9,
      money_limit_clp: 50000,
      handoff_user_id: 'u-sofia',
      firma_en_cada_mensaje: false,
      pulso: { activo: true, desde: '09:00', hasta: '18:00', cada_minutos: 40, max_por_persona: 6 },
      escalation_notice: 'Ya le avisé al equipo.',
    });
  });

  it('cambiar el ritmo del pulso conserva el resto del pulso Y el resto de los límites', async () => {
    montar([
      {
        limits: {
          confidence_threshold: 0.4,
          pulso: { activo: true, desde: '09:00', hasta: '18:00', max_por_persona: 6 },
        },
      },
    ]);
    const cada = await screen.findByRole('spinbutton', { name: 'Cada cuántos minutos' });
    await userEvent.clear(cada);
    await userEvent.type(cada, '25');
    await userEvent.tab();

    await waitFor(() => expect(enviados).toHaveLength(1));
    expect(ultimo().limits).toEqual({
      confidence_threshold: 0.4,
      pulso: { activo: true, desde: '09:00', hasta: '18:00', max_por_persona: 6, cada_minutos: 25 },
    });
  });

  it('la firma nace prendida, y apagarla no toca nada más', async () => {
    montar([{ limits: { confidence_threshold: 0.7, escalation_notice: 'Te responde una persona.' } }]);
    const firma = await screen.findByRole('switch', { name: 'Firmar cada mensaje' });
    expect(firma).toBeChecked();

    await userEvent.click(firma);
    await waitFor(() => expect(enviados).toHaveLength(1));
    expect(ultimo().limits).toEqual({
      confidence_threshold: 0.7,
      escalation_notice: 'Te responde una persona.',
      firma_en_cada_mensaje: false,
    });
  });
});

describe('el pulso nace apagado y se ve su ritmo (#1230)', () => {
  it('nace apagado, y ponerle ritmo no lo prende', async () => {
    montar([{ limits: { confidence_threshold: 0.7 } }]);
    expect(await screen.findByText('Apagado')).toBeVisible();

    const cada = screen.getByRole('spinbutton', { name: 'Cada cuántos minutos' });
    await userEvent.clear(cada);
    await userEvent.type(cada, '30');
    await userEvent.tab();

    await waitFor(() => expect(enviados).toHaveLength(1));
    expect(ultimo().limits).toEqual({ confidence_threshold: 0.7, pulso: { cada_minutos: 30 } });
    expect(screen.getByRole('switch', { name: 'Retomar conversaciones solo' })).not.toBeChecked();
    expect(screen.getByText('Apagado')).toBeVisible();
  });

  it('prenderlo escribe el horario que la pantalla está mostrando, y el ritmo queda a la vista', async () => {
    montar([{ limits: {} }]);
    await userEvent.click(await screen.findByRole('switch', { name: 'Retomar conversaciones solo' }));

    await waitFor(() => expect(enviados).toHaveLength(1));
    // Sin el horario, `configDelPulso` devuelve null: quedaría un interruptor
    // prendido que no manda un solo mensaje.
    expect(ultimo().limits).toEqual({ pulso: { activo: true, desde: '09:00', hasta: '18:00' } });

    const estado = await screen.findByText(/Escribe solo cada/);
    expect(estado).toHaveTextContent('Escribe solo cada 40 min, de 09:00 a 18:00');
  });

  it('prendido sin horario no dice «prendido»: dice que no manda nada', async () => {
    // El estado que deja un script que escribió `activo` y no el horario.
    montar([{ limits: { pulso: { activo: true } } }]);
    expect(await screen.findByText('Prendido sin horario: no manda nada')).toBeVisible();
    expect(screen.queryByText(/Escribe solo cada/)).not.toBeInTheDocument();
  });

  it('con dos asistentes, el que NO da el pulso lo dice', async () => {
    // `agenteConPulso` toma el primero activo que lo tenga prendido, así que
    // prenderlo en el segundo no agrega un segundo pulso.
    montar([
      { id: 'ag-jose', name: 'José', limits: {} },
      { id: 'ag-sofia', name: 'Sofía', limits: { pulso: { activo: true, desde: '09:00', hasta: '18:00' } } },
    ]);
    expect(await screen.findByText(/El pulso lo está dando Sofía/)).toBeVisible();
  });
});

describe('a quién le queda la conversación derivada (#1230)', () => {
  it('las opciones son las personas del equipo, y elegir una conserva los límites', async () => {
    montar([{ limits: { confidence_threshold: 0.4, escalation_notice: 'Te responde una persona.' } }]);
    await userEvent.click(
      await screen.findByRole('combobox', { name: 'A quién le queda la conversación' }),
    );
    // Nunca «Sin nombre» (#1139): quien no puso nombre aparece por su correo.
    expect(await screen.findByRole('option', { name: 'nuevo@negocio.cl' })).toBeVisible();
    await userEvent.click(screen.getByRole('option', { name: 'Sofía Vargas' }));

    await waitFor(() => expect(enviados).toHaveLength(1));
    expect(ultimo().limits).toEqual({
      confidence_threshold: 0.4,
      escalation_notice: 'Te responde una persona.',
      handoff_user_id: 'u-sofia',
    });
  });

  it('sin permiso para leer el equipo, el selector se apaga y el resto sigue guardando', async () => {
    montar([{ limits: { confidence_threshold: 0.4 } }], 'sin_permiso');
    expect(await screen.findByText(/No pudimos leer tu equipo/)).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'A quién le queda la conversación' })).toBeDisabled();

    const tono = screen.getByRole('textbox', { name: 'El tono' });
    await userEvent.type(tono, 'Directa y corta.');
    await userEvent.tab();
    await waitFor(() => expect(enviados).toHaveLength(1));
    expect(ultimo()).toEqual({ personality: 'Directa y corta.' });
  });
});

describe('el tono (#1230)', () => {
  it('se guarda en `personality`', async () => {
    montar([{ personality: 'Formal y breve.' }]);
    const tono = await screen.findByRole('textbox', { name: 'El tono' });
    expect(tono).toHaveValue('Formal y breve.');

    await userEvent.clear(tono);
    await userEvent.type(tono, 'Cercana, trata de tú.');
    await userEvent.tab();
    await waitFor(() => expect(enviados).toHaveLength(1));
    expect(ultimo()).toEqual({ personality: 'Cercana, trata de tú.' });
  });

  it('avisa cuando el prompt propio del asistente lo tapa, y no avisa cuando no lo hay', async () => {
    // `runtime.ts`: el prompt del sistema es
    // `promptName ?? fallbackSystemPrompt ?? plantilla-con-la-personalidad`.
    const vista = montar([{ fallbackSystemPrompt: 'Eres el asistente de la barbería.' }]);
    expect(await screen.findByText(/el modelo no lo va a leer/)).toBeVisible();

    vista.unmount();
    montar([{ fallbackSystemPrompt: null, promptName: null }]);
    await screen.findByRole('textbox', { name: 'El tono' });
    expect(screen.queryByText(/el modelo no lo va a leer/)).not.toBeInTheDocument();
  });
});
