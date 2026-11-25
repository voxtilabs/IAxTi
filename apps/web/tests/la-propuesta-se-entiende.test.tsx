// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Propuesta } from '../components/agente/propuesta';

/**
 * La propuesta del asistente se entiende sin saber programar (#1388).
 *
 * El caso real, tal como lo armó el Agente General el 25-11 para una
 * peluquería: la tarjeta dibujaba los trece argumentos de `agents.create` en
 * crudo —promptName, fallbackSystemPrompt, un JSON de límites— justo en el
 * momento en que se le pide a la dueña que apruebe.
 */
const CREAR_ASISTENTE = {
  herramienta: 'agents.create',
  descripcion: 'Crea un asistente (proveedor y modelo configurables)',
  metodo: 'POST',
  ruta: '/v1/agents',
  permiso: 'agents.configure',
  argumentos: {
    name: 'Precios Peluquería Ñuñoa',
    personality: 'Tono cálido, breve y de tú. Responde precios claros.',
    language: 'es-CL',
    provider: 'openai',
    model: 'gpt-4o-mini',
    promptName: 'precio_simple',
    promptVersion: '1.0',
    fallbackSystemPrompt: 'Responde en español de Chile, breve y cálido.',
    allowedTools: [],
    defaultMode: 'assist',
    limits: { confidence_threshold: 0.4, max_agent_turns: 6 },
    objetivo: 'informar',
    objetivoDetalle: 'Responder precios de corte mujer $15.000 y color desde $35.000',
  },
};

const montar = (propuesta: Parameters<typeof Propuesta>[0]['propuesta'] = CREAR_ASISTENTE) =>
  render(<Propuesta propuesta={propuesta} aplicando={false} onAplicar={vi.fn()} />);

describe('la propuesta de crear un asistente', () => {
  it('dice lo que la dueña decide, con palabras suyas', () => {
    montar();
    expect(screen.getByText('Nombre')).toBeTruthy();
    expect(screen.getByText('Precios Peluquería Ñuñoa')).toBeTruthy();
    expect(screen.getByText('Cómo habla')).toBeTruthy();
    expect(screen.getByText('Qué hace')).toBeTruthy();
    expect(screen.getByText(/Responder precios de corte mujer/)).toBeTruthy();
    expect(screen.getByText('Modo')).toBeTruthy();
    // assist → que la dueña entienda qué significa.
    expect(screen.getByText('Te propone y tú confirmas')).toBeTruthy();
  });

  it('lo técnico no está a la vista: va plegado, y sigue ahí', () => {
    const { container } = montar();
    const detalle = container.querySelector('details');
    expect(detalle, 'el detalle técnico tiene que existir').not.toBeNull();
    expect(detalle!.open).toBe(false);
    // Fuera del detalle no queda nada en camelCase ni JSON crudo.
    const fuera = [...container.querySelectorAll('dt')].filter((dt) => !detalle!.contains(dt)).map((dt) => dt.textContent);
    expect(fuera.some((t) => /[a-z][A-Z]|^(provider|model|language|limits)$/.test(t ?? ''))).toBe(false);
    // Dentro, el dato completo: auditable.
    fireEvent.click(detalle!.querySelector('summary')!);
    expect(detalle!.textContent).toContain('promptName');
    expect(detalle!.textContent).toContain('gpt-4o-mini');
  });

  it('una herramienta sin mapa se muestra como antes: no se inventan rótulos', () => {
    montar({ ...CREAR_ASISTENTE, herramienta: 'algo.desconocido', argumentos: { fooBar: 'x' } });
    expect(screen.getByText('fooBar')).toBeTruthy();
    expect(screen.getByText('x')).toBeTruthy();
  });
});
