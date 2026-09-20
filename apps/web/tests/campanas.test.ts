import { describe, expect, it } from 'vitest';
import type { CampaignChannel, CampaignPreview } from '@iaxti/sdk';
import { impedimentoDeCampana, mismaVistaPrevia } from '../lib/campanas';

const previa: CampaignPreview = { total: 1, muestra: [{ id: 'c', name: 'Ana', phone: '+56980000000' }] };
const canal: CampaignChannel = { id: 'w', kind: 'whatsapp', state: 'active', numbers: [{ id: 'n', displayPhone: '+56980000000', quality: 'green' }] };

describe('protecciones de la pantalla de campañas (#348)', () => {
  it('sin vista previa o sin poder comprobar el número no habilita envío', () => {
    expect(impedimentoDeCampana([canal], null)).toMatch(/primero/);
    expect(impedimentoDeCampana(null, previa)).toMatch(/comprobar/);
    expect(impedimentoDeCampana([], previa)).toMatch(/Conecta/);
  });
  it('calidad roja, desconocida, pausa o desconexión explican el bloqueo', () => {
    for (const [cambio, motivo] of [
      [{ quality: 'red' as const }, /rojo/],
      [{ quality: null }, /no está disponible/],
      [{ businessPausedAt: '2026-09-19T00:00:00Z' }, /pausados/],
    ] as const) {
      expect(impedimentoDeCampana([{ ...canal, numbers: [{ ...canal.numbers[0], ...cambio }] }], previa)).toMatch(motivo);
    }
    expect(impedimentoDeCampana([{ ...canal, state: 'disconnected' }], previa)).toMatch(/sin conexión/);
  });
  it('segmento vacío o sobre el máximo no promete un envío parcial', () => {
    expect(impedimentoDeCampana([canal], { ...previa, total: 0 })).toMatch(/no tiene/);
    expect(impedimentoDeCampana([canal], { ...previa, total: 5001 })).toMatch(/máximo/);
    expect(impedimentoDeCampana([canal], previa)).toBeNull();
    expect(impedimentoDeCampana([{ ...canal, numbers: [{ ...canal.numbers[0], quality: 'yellow' }] }], previa)).toBeNull();
  });
  it('un cambio en conteo o muestra obliga a revisar de nuevo', () => {
    expect(mismaVistaPrevia(previa, structuredClone(previa))).toBe(true);
    expect(mismaVistaPrevia(previa, { ...previa, total: 2 })).toBe(false);
    expect(mismaVistaPrevia(previa, { ...previa, muestra: [{ ...previa.muestra[0], id: 'otro' }] })).toBe(false);
  });
});
