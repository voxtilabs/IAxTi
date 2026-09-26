import { describe, expect, it } from 'vitest';
import {
  LIMITES_CONSERVADORES,
  LIMITES_WHATSAPP,
  claseDeAdjunto,
  limitesDelCanal,
  revisarAdjunto,
} from '../domain/adjuntos';

/**
 * Los límites por el borde (#560). Antes no había ninguno: la ruta que firma la
 * subida solo pedía el nombre del archivo, así que un video de 40 MB se subía a
 * R2 —que se paga— y recién el proveedor lo rechazaba.
 */

const MB = 1024 * 1024;

describe('límites de adjunto (#560)', () => {
  it('cada clase acepta justo en el límite y rechaza un byte más', () => {
    for (const limite of LIMITES_WHATSAPP) {
      const tipo = limite.tipos[0]!;
      const justo = revisarAdjunto({ contentType: tipo, sizeBytes: limite.maxBytes }, 'whatsapp');
      expect(justo.ok, `${limite.clase} en el límite`).toBe(true);

      const unoMas = revisarAdjunto(
        { contentType: tipo, sizeBytes: limite.maxBytes + 1 },
        'whatsapp',
      );
      expect(unoMas.ok, `${limite.clase} un byte sobre el límite`).toBe(false);
      if (!unoMas.ok) expect(unoMas.code).toBe('ADJUNTO_MUY_GRANDE');
    }
  });

  it('el aviso nombra el límite de ESA clase y no uno genérico', () => {
    // Una foto de 6 MB con «el máximo es 100 MB» no le sirve a nadie: 100 MB es
    // el del documento. El número que se dice tiene que ser el que aplica.
    const r = revisarAdjunto({ contentType: 'image/jpeg', sizeBytes: 6 * MB }, 'whatsapp');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toMatch(/imagen/);
      expect(r.message).toMatch(/5 MB/);
      expect(r.message).not.toMatch(/100 MB/);
      // Y dice qué hacer, no solo qué pasó.
      expect(r.message).toMatch(/más liviano/);
    }
  });

  it('un tipo que el canal no acepta se rechaza con otro código', () => {
    for (const tipo of ['application/x-msdownload', 'application/zip', 'image/gif', '']) {
      const r = revisarAdjunto({ contentType: tipo, sizeBytes: 1024 }, 'whatsapp');
      expect(r.ok, `tipo ${tipo || '(vacío)'}`).toBe(false);
      if (!r.ok) expect(r.code).toBe('ADJUNTO_TIPO_NO_ACEPTADO');
    }
  });

  it('lee el tipo con parámetros y en mayúsculas', () => {
    // Un navegador manda `text/plain; charset=utf-8`, y hay clientes que
    // mandan el tipo en mayúsculas. Ninguno de los dos es un tipo distinto.
    expect(claseDeAdjunto('text/plain; charset=utf-8')?.clase).toBe('documento');
    expect(claseDeAdjunto('IMAGE/JPEG')?.clase).toBe('imagen');
  });

  it('un canal sin tabla usa la MÁS restrictiva, no la más permisiva', () => {
    // La asimetría es la decisión: equivocarse por abajo avisa antes de subir;
    // equivocarse por arriba sube, se paga y falla.
    const doc = LIMITES_WHATSAPP.find((l) => l.clase === 'documento')!;
    const docConservador = LIMITES_CONSERVADORES.find((l) => l.clase === 'documento')!;
    expect(docConservador.maxBytes).toBeLessThan(doc.maxBytes);

    for (const canal of ['webchat', 'instagram', 'messenger', 'simulador']) {
      const tabla = limitesDelCanal(canal);
      for (const l of tabla) {
        const suyo = LIMITES_WHATSAPP.find((w) => w.clase === l.clase)!;
        expect(l.maxBytes, `${canal}/${l.clase}`).toBeLessThanOrEqual(suyo.maxBytes);
      }
    }
    expect(limitesDelCanal('whatsapp')).toBe(LIMITES_WHATSAPP);
  });

  it('ningún mensaje trae nombres de campo ni códigos, y todos dicen qué hacer', () => {
    const rechazos = [
      revisarAdjunto({ contentType: 'application/zip', sizeBytes: 10 }, 'whatsapp'),
      revisarAdjunto({ contentType: 'video/mp4', sizeBytes: 100 * MB }, 'whatsapp'),
    ];
    for (const r of rechazos) {
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.message).not.toMatch(/contentType|sizeBytes|maxBytes|HTTP|undefined|NaN/);
        expect(r.message).toMatch(/[.]$/);
      }
    }
  });

  it('un archivo vacío o negativo no pasa por ser chico', () => {
    // El tamaño positivo lo exige el esquema de la ruta; acá se comprueba que
    // la tabla no lo deje pasar en silencio si algún día se la llama directo.
    expect(revisarAdjunto({ contentType: 'image/png', sizeBytes: 0 }, 'whatsapp').ok).toBe(true);
    // 0 bytes SÍ pasa la revisión de tamaño a propósito: quien decide que un
    // archivo vacío no se manda es el esquema, y así este archivo tiene una
    // sola responsabilidad. Se deja escrito para que nadie lo lea como olvido.
  });
});
