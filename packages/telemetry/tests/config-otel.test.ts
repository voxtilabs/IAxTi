import { describe, expect, it } from 'vitest';
import { revisarConfigOtel } from '../src/index';

// La telemetría que no exporta y no lo dice (#17).
//
// El SDK lee las OTEL_EXPORTER_OTLP_* solo y no valida nada: arranca, manda,
// el colector rechaza, y ese rechazo no aparece en ningún log. Los tableros
// quedan vacíos — que se lee exactamente igual que "no pasó nada".

describe('revisarConfigOtel', () => {
  it('sin endpoint no hay problema: apagado es una decisión, no un error', () => {
    expect(revisarConfigOtel({})).toEqual([]);
    // Y unas cabeceras sueltas sin endpoint tampoco: no se exporta nada igual.
    expect(revisarConfigOtel({ OTEL_EXPORTER_OTLP_HEADERS: 'basura' })).toEqual([]);
  });

  it('el caso real de staging: "Basic" sin la credencial detrás', () => {
    // Sintaxis válida para el parser del SDK, credencial vacía para Grafana.
    // Rechaza TODO y nadie se entera.
    const p = revisarConfigOtel({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otlp-gateway.grafana.net/otlp',
      OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Basic',
    });
    expect(p).toHaveLength(1);
    expect(p[0].variable).toBe('OTEL_EXPORTER_OTLP_HEADERS');
    expect(p[0].problema).toContain('sin la credencial');
    // El aviso dice QUÉ hacer, no solo qué está mal.
    expect(p[0].problema).toContain('Authorization=Basic <credencial>');
  });

  it('con la credencial de verdad no se queja', () => {
    expect(
      revisarConfigOtel({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otlp-gateway.grafana.net/otlp',
        OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Basic MTIzNDU2OmdsY19hYmM=',
      }),
    ).toEqual([]);
  });

  it('Bearer pelado también, y varias cabeceras se revisan todas', () => {
    const p = revisarConfigOtel({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://x.dev/otlp',
      OTEL_EXPORTER_OTLP_HEADERS: 'X-Scope-OrgID=123,Authorization=Bearer,Otra=',
    });
    expect(p).toHaveLength(2);
    expect(p.map((x) => x.problema).join(' ')).toContain('sin la credencial');
    expect(p.map((x) => x.problema).join(' ')).toContain('"Otra" va vacía');
  });

  it('una cabecera sin = se avisa en vez de mandarse a medias', () => {
    const p = revisarConfigOtel({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://x.dev/otlp',
      OTEL_EXPORTER_OTLP_HEADERS: 'AuthorizationBasic123',
    });
    expect(p[0].problema).toContain('no tiene forma nombre=valor');
  });

  it('un endpoint sin esquema no llega a ninguna parte', () => {
    const p = revisarConfigOtel({ OTEL_EXPORTER_OTLP_ENDPOINT: 'otlp-gateway.grafana.net' });
    expect(p[0].variable).toBe('OTEL_EXPORTER_OTLP_ENDPOINT');
    expect(p[0].problema).toContain('http://');
  });

  it('sin cabeceras no se inventa un problema: hay colectores sin auth', () => {
    expect(
      revisarConfigOtel({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' }),
    ).toEqual([]);
    expect(
      revisarConfigOtel({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318', OTEL_EXPORTER_OTLP_HEADERS: '' }),
    ).toEqual([]);
  });
});
