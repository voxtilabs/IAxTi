import { describe, expect, it } from 'vitest';
import {
  DEFINICIONES,
  OBJETIVOS,
  componerPrompt,
  esObjetivo,
  resolverObjetivo,
} from '../domain/objetivo';

// El objetivo final del agente (#315): no es un rótulo, es lo que decide las
// herramientas, el prompt y cuándo el agente NO puede prometer.

describe('el catálogo de objetivos', () => {
  it('cada uno declara qué necesita, qué ofrece y qué cuenta como logrado', () => {
    for (const id of OBJETIVOS) {
      const d = DEFINICIONES[id];
      expect(d.id).toBe(id);
      expect(d.instruccion).toContain('{detalle}');
      expect(d.titulo.length).toBeGreaterThan(0);
      expect(d.detallePorDefecto.length).toBeGreaterThan(0);
      // Las tools se nombran <modulo>.<accion>: el prefijo ES el módulo
      // dueño, y de ahí sale si se puede ofrecer.
      for (const t of d.tools) expect(t).toMatch(/^[a-z]+\.[a-z_]+$/);
    }
    expect(esObjetivo('agendar')).toBe(true);
    expect(esObjetivo('conquistar_el_mundo')).toBe(false);
  });

  it('agendar reunión y agendar visita son EL MISMO objetivo', () => {
    // La decisión de diseño, escrita como test: lo único que cambia entre
    // una reunión y una visita a terreno son las palabras. Mismas tools,
    // mismo evento de éxito, misma regla de escalamiento. Dos valores de
    // enum duplicarían toda la lógica por una diferencia de redacción.
    const reunion = resolverObjetivo('agendar', 'una reunión por Meet', ['calendar']);
    const visita = resolverObjetivo('agendar', 'una visita a terreno', ['calendar']);
    expect(reunion.tools).toEqual(visita.tools);
    expect(reunion.definicion.eventoDeExito).toEqual(visita.definicion.eventoDeExito);
    expect(reunion.instruccion).toContain('una reunión por Meet');
    expect(visita.instruccion).toContain('una visita a terreno');
  });

  it('sin detalle usa la palabra por defecto, no deja el hueco', () => {
    const r = resolverObjetivo('agendar', null, ['calendar']);
    expect(r.instruccion).not.toContain('{detalle}');
    expect(r.instruccion).toContain('una hora');
    expect(resolverObjetivo('vender', '   ', ['crm']).instruccion).toContain('una cotización');
  });
});

describe('el objetivo contra la realidad del tenant', () => {
  it('solo ofrece las tools de módulos activos', () => {
    const conTodo = resolverObjetivo('vender', null, ['crm', 'knowledge', 'conversations']);
    expect(conTodo.tools).toContain('knowledge.search');
    expect(conTodo.tools).toContain('crm.create_deal');
    // Sin knowledge, la tool de catálogo no se ofrece: un agente que no
    // puede consultar precios no debe tener cómo decir que los consultó.
    const sinCatalogo = resolverObjetivo('vender', null, ['crm']);
    expect(sinCatalogo.tools).not.toContain('knowledge.search');
    expect(sinCatalogo.tools).toContain('crm.create_deal');
    expect(sinCatalogo.alcanzable).toBe(true); // crm sí está: el objetivo se puede
  });

  it('un objetivo cuyo módulo está apagado NO es alcanzable, y se dice', () => {
    const r = resolverObjetivo('agendar', 'una visita', ['crm']);
    expect(r.alcanzable).toBe(false);
    expect(r.faltan).toEqual(['calendar']);
    expect(r.tools).toEqual([]);

    const prompt = componerPrompt('Eres Sofía, cercana.', r)!;
    // Lo que evita el peor resultado posible: prometer una hora que nadie
    // puede dar. La regla de negocio ya lo exigía; acá deja de depender de
    // que alguien se acuerde de escribirlo en el prompt.
    expect(prompt).toContain('NO tienes cómo cumplir esto');
    expect(prompt).toContain('calendar');
    expect(prompt).toContain('pasa la conversación');
    // Y no le pide datos para cerrar algo que no puede cerrar.
    expect(prompt).not.toContain('Antes de cerrar necesitas');
  });
});

describe('la composición del prompt', () => {
  it('el objetivo va PRIMERO y el prompt del dueño se conserva', () => {
    const r = resolverObjetivo('agendar', 'una hora', ['calendar']);
    const prompt = componerPrompt('Eres Sofía. Tutea y sé breve.', r)!;
    expect(prompt.indexOf('dejar lista una hora')).toBeLessThan(prompt.indexOf('Eres Sofía'));
    // Lo que el dueño escribió no se pierde: el objetivo se SUMA.
    expect(prompt).toContain('Tutea y sé breve');
    expect(prompt).toContain('Antes de cerrar necesitas: el horario que prefiere, nombre.');
  });

  it('sin objetivo, el prompt queda exactamente como estaba', () => {
    // Los agentes que ya existen no se rompen: objetivo es opcional.
    expect(componerPrompt('Eres Sofía.', null)).toBe('Eres Sofía.');
    expect(componerPrompt(null, null)).toBeNull();
  });

  it('con objetivo y sin prompt del dueño, igual sabe qué tiene que lograr', () => {
    const r = resolverObjetivo('informar', 'los precios y horarios', ['knowledge']);
    const prompt = componerPrompt(null, r)!;
    expect(prompt).toContain('los precios y horarios');
    expect(prompt).toContain('inventar es peor que no saber');
  });
});
