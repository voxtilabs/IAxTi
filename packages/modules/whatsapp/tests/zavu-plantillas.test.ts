import { describe, expect, it } from 'vitest';
import {
  categoriaDeZavu,
  categoriaParaZavu,
  consultarEnZavu,
  crearEnZavu,
  enviarARevisionEnZavu,
  envioDePlantilla,
  estadoDeZavu,
  listarEnZavu,
  sincronizarConZavu,
} from '../application/zavu-plantillas';

/**
 * Las plantillas contra la API de Zavu (#44).
 *
 * Lo que se comprueba es la FORMA de lo que sale: la ruta, el método, la
 * cabecera y los nombres de campo, contra lo que documenta el proveedor. Es
 * la lección de ayer — escribí un adaptador de memoria y estaba mal hasta
 * probarlo contra la API real.
 */
function espia(respuesta: unknown, estado = 200) {
  const llamadas: Array<{ url: string; metodo: string; headers: Record<string, string>; cuerpo: unknown }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    llamadas.push({
      url: String(url),
      metodo: init.method ?? 'GET',
      headers: init.headers as Record<string, string>,
      cuerpo: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    return {
      ok: estado < 400,
      status: estado,
      json: async () => respuesta,
      text: async () => JSON.stringify(respuesta),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { llamadas, cfg: { apiKey: 'zv_test_abc', fetchImpl } };
}

describe('crear y mandar a revisión', () => {
  it('crea en POST /v1/templates con la categoría en MAYÚSCULA', async () => {
    const { llamadas, cfg } = espia({ id: 'tpl_1', name: 'recordatorio', language: 'es', category: 'UTILITY', status: 'draft' });
    const t = await crearEnZavu(cfg, {
      name: 'recordatorio',
      language: 'es',
      body: 'Hola {{1}}, te recordamos tu hora.',
      category: 'utility',
      footer: 'Responde SALIR para no recibir más',
      variables: ['nombre'],
    });

    expect(llamadas[0].url).toBe('https://api.zavu.dev/v1/templates');
    expect(llamadas[0].metodo).toBe('POST');
    expect(llamadas[0].headers.Authorization).toBe('Bearer zv_test_abc');
    expect(llamadas[0].cuerpo).toMatchObject({
      name: 'recordatorio',
      language: 'es',
      whatsappCategory: 'UTILITY',
      variables: ['nombre'],
      footer: 'Responde SALIR para no recibir más',
    });
    expect(t.id).toBe('tpl_1');
    expect(t.status).toBe('draft');
  });

  it('la manda a revisión en /submit, con el sender', async () => {
    const { llamadas, cfg } = espia({ id: 'tpl_1', name: 'x', language: 'es', category: 'UTILITY', status: 'pending' });
    const t = await enviarARevisionEnZavu(cfg, {
      templateId: 'tpl_1',
      senderId: 'snd_9',
      category: 'utility',
    });
    expect(llamadas[0].url).toBe('https://api.zavu.dev/v1/templates/tpl_1/submit');
    expect(llamadas[0].cuerpo).toEqual({ senderId: 'snd_9', category: 'UTILITY' });
    expect(t.status).toBe('pending');
  });

  it('el motivo del rechazo del proveedor llega entero, no como "falló"', async () => {
    const { cfg } = espia({ error: 'template name already exists' }, 409);
    await expect(
      crearEnZavu(cfg, { name: 'repetida', language: 'es', body: 'hola {{1}} ya', category: 'utility' }),
    ).rejects.toThrow(/HTTP 409.*already exists/);
  });
});

describe('lo que dice Meta manda sobre lo que dice Zavu', () => {
  it('una plantilla aprobada en Zavu pero PAUSADA en Meta no está aprobada', async () => {
    const { cfg } = espia({
      id: 'tpl_1',
      name: 'promo',
      language: 'es',
      category: 'MARKETING',
      status: 'approved',
      whatsapp: { status: 'PAUSED' },
    });
    const t = await consultarEnZavu(cfg, 'tpl_1');
    expect(t.status).toBe('paused');
  });

  it('un estado que no entendemos no se inventa', () => {
    expect(estadoDeZavu('IN_APPEAL')).toBeNull();
    expect(estadoDeZavu('lo_que_sea')).toBeNull();
    expect(estadoDeZavu('APPROVED')).toBe('approved');
  });

  it('las categorías van y vuelven', () => {
    expect(categoriaParaZavu('marketing')).toBe('MARKETING');
    expect(categoriaDeZavu('AUTHENTICATION')).toBe('authentication');
    // Una categoría rara no rompe: cae en la más inocua.
    expect(categoriaDeZavu('promocional')).toBe('utility');
  });
});

describe('el envío de una plantilla', () => {
  it('sale como messageType template, con las variables por posición', () => {
    expect(envioDePlantilla({ providerId: 'tpl_1', valores: ['Ana', 'martes 10:30'] })).toEqual({
      messageType: 'template',
      content: {
        templateId: 'tpl_1',
        templateVariables: { '1': 'Ana', '2': 'martes 10:30' },
      },
    });
  });

  it('sin variables no manda el campo vacío', () => {
    expect(envioDePlantilla({ providerId: 'tpl_1', valores: [] })).toEqual({
      messageType: 'template',
      content: { templateId: 'tpl_1' },
    });
  });

  it('una plantilla que el proveedor no conoce no se manda', () => {
    expect(() => envioDePlantilla({ providerId: null, name: 'sin_registrar' })).toThrow(
      /no está registrada en el proveedor/,
    );
  });
});

describe('sincronizar', () => {
  it('destraba las que se quedaron en revisión por un webhook perdido', async () => {
    const { llamadas, cfg } = espia({ accountsSynced: 1, imported: 2, linked: 1, updated: 3, skipped: 12, errors: [] });
    const r = await sincronizarConZavu(cfg, 'snd_9');
    expect(llamadas[0].url).toBe('https://api.zavu.dev/v1/templates/sync');
    expect(llamadas[0].cuerpo).toEqual({ senderId: 'snd_9' });
    expect(r).toMatchObject({ importadas: 2, enlazadas: 1, actualizadas: 3 });
  });

  it('sin sender, sincroniza todo el proyecto', async () => {
    const { llamadas, cfg } = espia({ imported: 0, linked: 0, updated: 0, errors: [] });
    await sincronizarConZavu(cfg);
    expect(llamadas[0].cuerpo).toEqual({});
  });
});

describe('listar', () => {
  it('recorre todas las páginas del cursor', async () => {
    const paginas = [
      { items: [{ id: 'tpl_1', name: 'a', language: 'es', status: 'approved' }], nextCursor: 'c2' },
      { items: [{ id: 'tpl_2', name: 'b', language: 'es', status: 'pending' }], nextCursor: null },
    ];
    const urls: string[] = [];
    let i = 0;
    const fetchImpl = (async (url: string) => {
      urls.push(String(url));
      const cuerpo = paginas[i];
      i += 1;
      return { ok: true, status: 200, json: async () => cuerpo } as unknown as Response;
    }) as unknown as typeof fetch;

    const todas = await listarEnZavu({ apiKey: 'zv_test_abc', fetchImpl });
    expect(todas.map((t) => t.id)).toEqual(['tpl_1', 'tpl_2']);
    expect(urls[1]).toContain('cursor=c2');
  });

  it('un cursor que no avanza no deja el barrido girando para siempre', async () => {
    let vueltas = 0;
    const fetchImpl = (async () => {
      vueltas += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ items: [{ id: 'tpl_1', name: 'a', language: 'es' }], nextCursor: 'igual' }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const todas = await listarEnZavu({ apiKey: 'zv_test_abc', fetchImpl });
    expect(vueltas).toBe(2); // la segunda repite el cursor y ahí se corta
    expect(todas).toHaveLength(2);
  });
});

describe('un rechazo', () => {
  it('trae el motivo de Meta, que es lo único que el negocio puede corregir', async () => {
    const { cfg } = espia({
      id: 'tpl_1',
      name: 'promo',
      language: 'es',
      category: 'MARKETING',
      status: 'pending',
      whatsapp: { status: 'REJECTED', rejectedReason: 'INVALID_FORMAT' },
    });
    const t = await consultarEnZavu(cfg, 'tpl_1');
    expect(t.status).toBe('rejected');
    expect(t.rejectionReason).toBe('INVALID_FORMAT');
  });
});
