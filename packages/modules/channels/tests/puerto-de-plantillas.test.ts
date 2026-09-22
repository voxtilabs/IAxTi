import { afterEach, describe, expect, it } from 'vitest';
import {
  getProvider,
  registerProvider,
  resetProviders,
  type ChannelProvider,
  type PlantillaDelProveedor,
  type PuertoDePlantillas,
} from '../domain/port';

/**
 * Salir del intermediario tiene que ser cambiar un adaptador (#159).
 *
 * Los mensajes ya eran portables —`send`, `verifyWebhook`, `normalize`— y
 * las plantillas no: la API y el worker llamaban a `crearEnZavu`,
 * `enviarARevisionEnZavu` y `listarEnZavu` POR SU NOMBRE. O sea que el plan
 * de salida era «una línea» en la mitad del producto y una reescritura en
 * la otra mitad, y eso no se ve hasta el día que hay que hacerlo.
 *
 * Este test es la prueba de que la salida existe: un proveedor inventado,
 * sin una línea de Zavu, cumple el puerto entero.
 */
const CUENTA = {
  id: 'cuenta-1',
  tenantId: 'tenant-1',
  kind: 'whatsapp' as const,
  name: 'Número del negocio',
  state: 'active' as const,
  credentialRef: 'LLAVE_DE_OTRO_PROVEEDOR',
  config: { senderId: 'emisor-1' },
};

function proveedorInventado(): ChannelProvider & { plantillas: PuertoDePlantillas } {
  const creadas: PlantillaDelProveedor[] = [];
  return {
    kind: 'whatsapp',
    send: async () => ({ providerMessageId: 'x' }),
    verifyWebhook: () => true,
    normalize: () => [],
    plantillas: {
      async crear(_cuenta, input) {
        const t = {
          id: `otro-${creadas.length + 1}`,
          name: input.name,
          language: input.language,
          status: null,
          category: input.category,
        };
        creadas.push(t);
        return t;
      },
      async enviarARevision(_cuenta, input) {
        const t = creadas.find((c) => c.id === input.templateId);
        if (!t) throw new Error('no existe');
        t.status = 'pending';
        return t;
      },
      async listar() {
        return creadas;
      },
    },
  };
}

afterEach(() => resetProviders());

describe('el puerto de plantillas', () => {
  it('un proveedor que no es Zavu cumple el ciclo entero', async () => {
    registerProvider(proveedorInventado());
    const plantillas = getProvider('whatsapp')!.plantillas!;

    const creada = await plantillas.crear(CUENTA, {
      name: 'recordatorio_cita',
      language: 'es',
      body: 'Hola {{1}}, te esperamos el {{2}}.',
      category: 'utility',
    });
    expect(creada.id).toBeTruthy();
    expect(creada.status).toBeNull();

    const enviada = await plantillas.enviarARevision(CUENTA, {
      templateId: creada.id,
      category: 'utility',
    });
    expect(enviada.status).toBe('pending');
    expect((await plantillas.listar(CUENTA)).map((t) => t.id)).toEqual([creada.id]);
  });

  it('el puerto no tiene un solo nombre del proveedor', async () => {
    // Un campo llamado `whatsappStatus` o `zavuId` sería la misma
    // dependencia por otra puerta: el que venga después tendría que
    // implementar la forma de Zavu para encajar.
    registerProvider(proveedorInventado());
    const t = await getProvider('whatsapp')!.plantillas!.crear(CUENTA, {
      name: 'x',
      language: 'es',
      body: 'y',
      category: 'utility',
    });
    for (const campo of Object.keys(t)) {
      expect(campo.toLowerCase()).not.toContain('zavu');
      expect(campo.toLowerCase()).not.toContain('whatsapp');
    }
  });

  it('un canal sin plantillas simplemente no las ofrece', async () => {
    // El webchat y el simulador no tienen. Que el puerto sea opcional es lo
    // que permite que existan sin fingir una capacidad que no tienen.
    registerProvider({
      kind: 'webchat',
      send: async () => ({ providerMessageId: 'x' }),
      verifyWebhook: () => true,
      normalize: () => [],
    });
    expect(getProvider('webchat')!.plantillas).toBeUndefined();
  });
});
