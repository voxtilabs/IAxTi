import { describe, expect, it, vi } from 'vitest';
import type { HerramientaExpuesta } from '@iaxti/module-agents';
import { abreLaOportunidad, quiereComprar } from '../src/abre-la-oportunidad';

/**
 * El embudo se llena por una regla, no por suerte (#1243).
 *
 * Lo medido el 3 de noviembre, por el camino real: un visitante escribió
 * «tengo una ferretería con 4 vendedores y quiero contratar esto», el agente
 * clasificó `intencion: "cotizar"`, `calificacion: "caliente"`, contestó bien
 * — y `tools_called: []`. Cero oportunidades, porque el prompt le pide
 * PROPONER la acción «para que quien atiende le dé el visto bueno», y en
 * autónomo no hay nadie atendiendo.
 */
const herramienta = (ejecutar: HerramientaExpuesta['ejecutar']): HerramientaExpuesta =>
  ({ name: 'crm.create_deal', description: '', parameters: {}, ejecutar }) as HerramientaExpuesta;

describe('quiereComprar', () => {
  it('la intención de compra basta', () => {
    expect(quiereComprar({ intencion: 'cotizar', calificacion: 'frio' })).toBe(true);
    expect(quiereComprar({ intencion: 'comprar', calificacion: null })).toBe(true);
  });

  it('estar caliente basta, con cualquier intención', () => {
    expect(quiereComprar({ intencion: 'soporte', calificacion: 'caliente' })).toBe(true);
  });

  /**
   * Las dos condiciones son FALSAS acá, y es a propósito: con una sola falsa
   * la prueba pasaría igual si el código usara `||` donde va `&&` o al revés.
   */
  it('preguntar no es querer comprar', () => {
    expect(quiereComprar({ intencion: 'consulta', calificacion: 'tibio' })).toBe(false);
    expect(quiereComprar({ intencion: null, calificacion: null })).toBe(false);
  });
});

describe('abreLaOportunidad', () => {
  const caliente = { intencion: 'cotizar', calificacion: 'caliente' };

  it('crea una con el nombre de quien escribió', async () => {
    const ejecutar = vi.fn().mockResolvedValue('creada');
    const r = await abreLaOportunidad({
      tools: [herramienta(ejecutar)],
      clasificacion: caliente,
      datos: { nombreDelContacto: 'Marcela Rojas', intencion: 'cotizar' },
      yaTiene: async () => false,
    });
    expect(r.creada).toBe(true);
    expect(ejecutar).toHaveBeenCalledWith({ title: 'Marcela Rojas — escribió al bot' });
  });

  /**
   * El argumento se llama `title` y no `titulo`, y esta línea es la única
   * razón por la que se sabe: `ejecutar` acepta cualquier objeto, así que un
   * nombre mal escrito no revienta — la herramienta recibe un título vacío,
   * falla su validación adentro y la oportunidad no aparece. Pasó al escribir
   * esto.
   */
  it('sin nombre todavía, un título que se entiende', async () => {
    const ejecutar = vi.fn().mockResolvedValue('creada');
    await abreLaOportunidad({
      tools: [herramienta(ejecutar)],
      clasificacion: caliente,
      datos: { nombreDelContacto: null, intencion: 'cotizar' },
      yaTiene: async () => false,
    });
    expect(ejecutar).toHaveBeenCalledWith({ title: 'Lead del bot' });
  });

  it('si ya tenía una abierta, no crea otra', async () => {
    const ejecutar = vi.fn();
    const r = await abreLaOportunidad({
      tools: [herramienta(ejecutar)],
      clasificacion: caliente,
      datos: { nombreDelContacto: 'Marcela', intencion: 'cotizar' },
      yaTiene: async () => true,
    });
    expect(r).toEqual({ creada: false, motivo: 'ya_tenia' });
    expect(ejecutar).not.toHaveBeenCalled();
  });

  /**
   * Sin identidad configurada la herramienta no viaja, y eso es lo que se
   * mira: preguntarle acá a `limits` por `actua_como_user_id` sería una
   * segunda fuente de verdad sobre lo mismo, y las dos se pueden desfasar.
   */
  it('sin identidad configurada no hay herramienta, y no pasa nada', async () => {
    const r = await abreLaOportunidad({
      tools: [],
      clasificacion: caliente,
      datos: { nombreDelContacto: 'Marcela', intencion: 'cotizar' },
      yaTiene: async () => false,
    });
    expect(r).toEqual({ creada: false, motivo: 'sin_identidad' });
  });

  it('nunca pregunta si ya tenía cuando la persona no quería comprar', async () => {
    const yaTiene = vi.fn();
    const r = await abreLaOportunidad({
      tools: [herramienta(vi.fn())],
      clasificacion: { intencion: 'consulta', calificacion: 'frio' },
      datos: { nombreDelContacto: 'Marcela', intencion: 'consulta' },
      yaTiene,
    });
    expect(r).toEqual({ creada: false, motivo: 'no_es_de_compra' });
    expect(yaTiene).not.toHaveBeenCalled();
  });

  /** El cliente ya tiene su respuesta: que el CRM falle no se la puede quitar. */
  it('si la herramienta falla, devuelve el motivo y no revienta', async () => {
    const r = await abreLaOportunidad({
      tools: [herramienta(vi.fn().mockRejectedValue(new Error('sin permiso crm.deals.create')))],
      clasificacion: caliente,
      datos: { nombreDelContacto: 'Marcela', intencion: 'cotizar' },
      yaTiene: async () => false,
    });
    expect(r.creada).toBe(false);
    expect(r.motivo).toBe('falló');
    expect(r.detalle).toContain('crm.deals.create');
  });
});
