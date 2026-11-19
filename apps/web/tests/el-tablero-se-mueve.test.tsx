// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Arranque } from '../components/arranque';
import type { DealCardDto, StageDto } from '../lib/api';

/**
 * El movimiento de una oportunidad (#1367), montado y usado.
 *
 * Lo que se mueve con la mano se tiene que poder mover con el teclado — y
 * hasta hoy no se podía: el arrastre HTML5 nativo solo existía para el
 * ratón. Esta suite atraviesa el pipeline completo de dnd-kit con el
 * SENSOR DE TECLADO (levantar con Espacio, cruzar con flechas, soltar con
 * Espacio), que por dentro es el mismo camino que usa el dedo: sensores →
 * medición → colisión → `onDragEnd`. Medir el movimiento con el dedo en
 * jsdom exigiría simular tacto que jsdom no tiene; el sensor de teclado sí
 * existe acá, y la decisión que sigue al soltar es la misma para los dos.
 */

const contexto = vi.hoisted(() => ({
  tenant: 'negocio-a', config: { apiUrl: 'http://api.local' },
  session: { access_token: 'sesion-a' },
}));
vi.mock('@iaxti/ui/react', async (original) => ({
  ...await original<typeof import('@iaxti/ui/react')>(),
  useSession: () => contexto,
}));
vi.mock('../components/tenant-switcher', () => ({ useSelectedTenant: () => contexto.tenant }));
vi.mock('../lib/api', async (original) => ({
  ...await original<typeof import('../lib/api')>(), apiFetch: vi.fn(),
}));
import { apiFetch } from '../lib/api';
import { Oportunidades } from '../components/crm/oportunidades';
import { ProveedorDeArranque } from '../components/arranque';

const pedir = vi.mocked(apiFetch);

/* Radix usa APIs de puntero que jsdom no trae; sin esto el Select cae con
   `hasPointerCapture is not a function`, que no se parece a su causa. */
Element.prototype.hasPointerCapture = () => false;
Element.prototype.releasePointerCapture = () => {};
Element.prototype.scrollIntoView = () => {};

const etapas: StageDto[] = [
  { id: 's1', name: 'Nuevo', position: 0, type: 'open', expectedDays: null },
  { id: 's2', name: 'Propuesta', position: 1, type: 'open', expectedDays: null },
  { id: 's3', name: 'Perdido', position: 2, type: 'lost', expectedDays: null },
];

const base: DealCardDto = {
  id: 'd?', createdAt: '2026-11-01T12:00:00Z', title: '?', status: 'open',
  stageId: 's1', stageName: 'Nuevo', value: 1000, currency: 'CLP', valueClp: 1000,
  stalled: false, ownerId: null, wonAt: null, lostAt: null,
  contactId: 'c1', contactName: 'Persona', contactPhone: '+56911112222',
  proximaActividad: null,
};
const tarjetas: Record<string, DealCardDto[]> = {
  s1: [{ ...base, id: 'd1', title: 'Venta de noviembre', stageId: 's1', stageName: 'Nuevo' }],
  s2: [{ ...base, id: 'd2', title: 'Propuesta mandada', stageId: 's2', stageName: 'Propuesta' }],
  s3: [],
};

/** La ficha que sirve `/deals/:id`. */
const fichaDe = (id: string, titulo: string, etapa: string) => ({
  deal: {
    id, title: titulo, status: 'open', value: 1000, currency: 'CLP',
    value_clp: 1000, stage_name: etapa, stage_type: 'open', pipeline_name: 'Ventas',
    contact_id: 'c1', contact_name: 'Persona', contact_phone: '+56911112222',
    stage_entered_at: '2026-11-01T12:00:00Z', stalled: false, created_at: '2026-11-01T12:00:00Z',
    won_at: null, lost_at: null, lost_reason: null, expected_close_date: null,
  },
  historia: [], activities: [], delAsistente: [],
});

const arranque = (permisos: string[]): Arranque =>
  ({
    modulos: [], permisos,
    acceso: { estado: 'ok', dato: [] },
    avisos: { estado: 'ok', dato: { items: [], unread: 0 } },
    respuestasRapidas: { estado: 'ok', dato: [] },
    etiquetas: { estado: 'ok', dato: [] },
  }) as unknown as Arranque;

/** Toda la API que el tablero toca, con los permisos que se pidan. */
function responder(permisos: string[]) {
  pedir.mockImplementation(async (_cfg, _ses, _ten, path: string) => {
    if (path === '/arranque') return arranque(permisos);
    if (path === '/pipelines') return [{ id: 'p1', name: 'Ventas', stages: etapas }];
    if (path === '/loss-reasons') return [{ id: 'lr1', label: 'Sin presupuesto' }];
    if (path === '/saved-filters') return [];
    if (path === '/pipelines/p1/embudo') return { oportunidades: 0, etapas: [] };
    if (path.startsWith('/deals/resumen')) return { items: [], ganado: null };
    if (path.startsWith('/deals?')) {
      const stage = new URLSearchParams(path.slice(path.indexOf('?') + 1)).get('stageId');
      return { items: tarjetas[stage ?? ''] ?? [], nextCursor: null };
    }
    if (path === '/deals/d1') return fichaDe('d1', 'Venta de noviembre', 'Nuevo');
    if (path === '/deals/d2') return fichaDe('d2', 'Propuesta mandada', 'Propuesta');
    if (path === '/deals/d1/stage') return { ok: true };
    if (path === '/deals/d2/stage') return { ok: true };
    throw new Error('ruta inesperada: ' + path);
  });
}

beforeEach(() => {
  // El caché del arranque vive FUERA de React y su llave es negocio+token:
  // sin devolver el token, un caso que cambia de sesión contagiaría al
  // siguiente el arranque ya servido.
  contexto.session = { access_token: 'sesion-a' };
  pedir.mockReset();
  responder(['crm.deals.read', 'crm.deals.update']);
});

/**
 * El DOM de mentira con el que jsdom le da geometría a dnd-kit: cada
 * columna con su ancho y cada tarjeta en la columna que esté.
 *
 * Va por ESTRUCTURA (etapa por posición, tarjeta por su columna) y se
 * instala ANTES de montar, no después: dnd-kit mide la tarjeta arrastrable
 * al montarla (`useRect`, layout effect) y en jsdom no hay ResizeObserver
 * que la vuelva a medir — la geometría puesta tarde es geometría que el
 * arrastre nunca ve, y un collisionRect de tamaño cero no choca con nada.
 */
function prepararRects() {
  const rect = (x: number, y = 0, w = 280, h = 400): DOMRect =>
    ({ x, y, width: w, height: h, top: y, left: x, right: x + w, bottom: y + h, toJSON: () => ({}) }) as DOMRect;
  const etapas = () => Array.from(document.querySelectorAll<HTMLElement>('section[aria-label^="Etapa "]'));
  Element.prototype.getBoundingClientRect = function () {
    const el = this as HTMLElement;
    if (el.tagName === 'SECTION' && el.getAttribute('aria-label')?.startsWith('Etapa ')) {
      return rect(etapas().indexOf(el) * 288);
    }
    if (el.tagName === 'ARTICLE') {
      const indice = etapas().indexOf(el.closest('section') as HTMLElement);
      if (indice >= 0) return rect(indice * 288 + 8, 40, 240, 90);
    }
    /* El `DragOverlay` nace sobre la tarjeta que refleja, y dnd-kit choca
       contra SU rect — no el de la original, que se quedó en la columna con
       opacity. Y ojo con QUIÉN mide: `getMeasurableNode` devuelve el primer
       HIJO del wrapper cuando es único, o sea este div de contenido (con
       `rotate-1` en su PROPIA clase), no el wrapper. Una regla que case al
       wrapper deja el collisionRect en tamaño cero y el arrastre no ve
       ninguna columna, aunque todo lo demás ande. La fuente se reconoce
       porque al arrastrarla queda `opacity-40` en su columna. */
    if (el.tagName === 'DIV' && el.className.includes('rotate-1')) {
      const fuente = document.querySelector<HTMLElement>('article.opacity-40');
      const indice = fuente ? etapas().indexOf(fuente.closest('section') as HTMLElement) : -1;
      if (indice >= 0) return rect(indice * 288 + 8, 40, 240, 90);
    }
    return rect(0, 0, 0, 0);
  };
}

const tarjeta = (titulo: string): HTMLElement => {
  const el = screen.getByText(titulo).closest('article');
  if (!el) throw new Error('sin tarjeta: ' + titulo);
  return el;
};

const movimientosA = (id: string) =>
  pedir.mock.calls.filter((c) => c[3] === `/deals/${id}/stage`);

/**
 * El listener que mueve el arrastre con las flechas se engancha al documento
 * un macrotask DESPUÉS de levantar (dnd-kit lo pospone con `setTimeout`).
 * Disparar la flecha en el mismo bloque síncrono que el Espacio es escribir
 * en el vacío: hay que soltar la pila primero.
 */
const unTick = () =>
  act(async () => {
    await new Promise<void>((resolver) => setTimeout(resolver, 0));
  });

const montar = async () => {
  prepararRects();
  render(<ProveedorDeArranque><Oportunidades /></ProveedorDeArranque>);
  await waitFor(() => {
    expect(screen.getByRole('region', { name: 'Etapa Perdido' })).toBeInTheDocument();
    expect(screen.getByText('Venta de noviembre')).toBeInTheDocument();
  });
};

/** Abre un Select de Radix y elige una opción por su nombre. */
async function elegir(combobox: string, opcion: string) {
  const usuario = userEvent.setup();
  await usuario.click(screen.getByRole('combobox', { name: combobox }));
  const lista = await screen.findByRole('listbox');
  await usuario.click(within(lista).getByRole('option', { name: opcion }));
}

/**
 * Escribir en un campo char a char. En una sola llamada `type` pierde todo
 * menos el último carácter DENTRO del Dialog de este tablero —reproducido
 * con `delay: null` también—, y char por char funciona. Char a char es,
 * además, lo más parecido a alguien escribiendo.
 */
async function escribir(campo: HTMLElement, texto: string) {
  const usuario = userEvent.setup();
  for (const letra of texto) await usuario.type(campo, letra);
}

describe('el tablero se mueve con el teclado (#1367)', () => {
  it('Espacio levanta, la flecha cruza y la columna de destino se marca antes de soltar', async () => {
    await montar();
    const d1 = tarjeta('Venta de noviembre');
    d1.focus();

    fireEvent.keyDown(d1, { code: 'Space', key: ' ' });
    await unTick();
    fireEvent.keyDown(d1, { code: 'ArrowRight', key: 'ArrowRight' });

    // La señal de «acá cae»: el anillo azul dentro de la columna de destino
    // mientras flota (va en un hijo, porque `pulso-panel` pinta el borde del
    // section fuera de las capas de Tailwind y la utilidad no gana).
    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: 'Etapa Propuesta' }).querySelector('.border-action'),
      ).not.toBeNull();
    });

    fireEvent.keyDown(d1, { code: 'Space', key: ' ' });
    await waitFor(() => expect(movimientosA('d1')).toHaveLength(1));

    const [,,,, init] = movimientosA('d1')[0]!;
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ stageId: 's2' });
  });

  it('retroceder abre el dialog del motivo, y no se mueve sin él', async () => {
    await montar();
    const d2 = tarjeta('Propuesta mandada');
    d2.focus();

    fireEvent.keyDown(d2, { code: 'Space', key: ' ' });
    await unTick();
    fireEvent.keyDown(d2, { code: 'ArrowLeft', key: 'ArrowLeft' });
    fireEvent.keyDown(d2, { code: 'Space', key: ' ' });

    // Nada se movió todavía: el movimiento espera su motivo.
    expect(movimientosA('d2')).toHaveLength(0);
    expect(screen.getByText('Retroceder de etapa')).toBeInTheDocument();

    await escribir(screen.getByPlaceholderText('Motivo del retroceso'), 'el cliente pidió tiempo');
    const usuario = userEvent.setup();
    await usuario.click(screen.getByRole('button', { name: 'Mover' }));

    await waitFor(() => expect(movimientosA('d2')).toHaveLength(1));
    expect(JSON.parse(String(movimientosA('d2')[0]![4]?.body))).toEqual({
      stageId: 's1',
      reason: 'el cliente pidió tiempo',
    });
  });

  it('soltar en Perdido ofrece los motivos del negocio', async () => {
    await montar();
    const d1 = tarjeta('Venta de noviembre');
    d1.focus();

    fireEvent.keyDown(d1, { code: 'Space', key: ' ' });
    await unTick();
    fireEvent.keyDown(d1, { code: 'ArrowRight', key: 'ArrowRight' });
    fireEvent.keyDown(d1, { code: 'ArrowRight', key: 'ArrowRight' });
    fireEvent.keyDown(d1, { code: 'Space', key: ' ' });

    expect(screen.getByText('Cerrar como perdida')).toBeInTheDocument();
    await elegir('Motivo de pérdida', 'Sin presupuesto');
    const usuario = userEvent.setup();
    await usuario.click(screen.getByRole('button', { name: 'Cerrar perdida' }));

    await waitFor(() => expect(movimientosA('d1')).toHaveLength(1));
    expect(JSON.parse(String(movimientosA('d1')[0]![4]?.body))).toEqual({
      stageId: 's3',
      lostReasonId: 'lr1',
    });
  });

  it('un clic sin arrastrar sigue abriendo la ficha', async () => {
    await montar();
    fireEvent.click(screen.getByText('Venta de noviembre'));
    expect(await screen.findByRole('complementary', { name: /Venta de noviembre/ })).toBeInTheDocument();
  });
});

describe('mover desde la ficha, el camino del que no arrastra (#1367)', () => {
  it('el selector de etapa mueve directo hacia adelante y la ficha se re-pide con la etapa nueva', async () => {
    await montar();
    fireEvent.click(screen.getByText('Venta de noviembre'));
    await screen.findByRole('complementary', { name: /Venta de noviembre/ });

    // Hacia adelante: sin dialog, movimiento directo.
    await elegir('Cambiar de etapa', 'Propuesta');
    await waitFor(() => expect(movimientosA('d1')).toHaveLength(1));
    expect(JSON.parse(String(movimientosA('d1')[0]![4]?.body))).toEqual({ stageId: 's2' });

    // La ficha se re-pide (version en la key): la etapa mostrada no puede
    // quedar vieja después de mover.
    await waitFor(() => {
      const fichas = pedir.mock.calls.filter((c) => c[3] === '/deals/d1');
      expect(fichas.length).toBeGreaterThan(1);
    });
  });

  it('retroceder desde la ficha abre el mismo dialog de motivo del tablero', async () => {
    await montar();
    fireEvent.click(screen.getByText('Propuesta mandada'));
    await screen.findByRole('complementary', { name: /Propuesta mandada/ });

    await elegir('Cambiar de etapa', 'Nuevo');
    expect(screen.getByText('Retroceder de etapa')).toBeInTheDocument();

    await escribir(screen.getByPlaceholderText('Motivo del retroceso'), 'volvió a dudar');
    const usuario = userEvent.setup();
    await usuario.click(screen.getByRole('button', { name: 'Mover' }));

    await waitFor(() => expect(movimientosA('d2')).toHaveLength(1));
    expect(JSON.parse(String(movimientosA('d2')[0]![4]?.body))).toEqual({
      stageId: 's1',
      reason: 'volvió a dudar',
    });
  });

  it('sin permiso de mover, la ficha no ofrece el selector', async () => {
    // Otro token: el caché del arranque (negocio+token, fuera de React) no
    // puede servir el arranque del caso anterior, que sí podía mover.
    contexto.session = { access_token: 'sesion-b' };
    responder(['crm.deals.read']);

    render(<ProveedorDeArranque><Oportunidades /></ProveedorDeArranque>);
    await waitFor(() => expect(screen.getByText('Venta de noviembre')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Venta de noviembre'));

    // La ficha cargó — sin este waitFor el caso pasaría sin abrir nada.
    const ficha = await screen.findByRole('complementary', { name: /Venta de noviembre/ });
    await waitFor(() => expect(within(ficha).getByText(/entró/)).toBeInTheDocument());

    expect(screen.queryByRole('combobox', { name: 'Cambiar de etapa' })).not.toBeInTheDocument();
  });
});
