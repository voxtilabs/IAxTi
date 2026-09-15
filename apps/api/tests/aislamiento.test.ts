import { describe, expect, it } from 'vitest';
import { ServiceUnavailableException, type ExecutionContext } from '@nestjs/common';
import type { EstadoRls } from '@iaxti/db';
import { AislamientoGuard } from '../src/aislamiento';

// Sin aislamiento verificado, la API no sirve datos (issue 227). Lo que se
// prueba acá es sobre todo cuándo NO debe cortar: un corte por error deja
// caído un ambiente sano, que es exactamente lo que pasó con staging.

const contexto = (path: string): ExecutionContext =>
  ({ switchToHttp: () => ({ getRequest: () => ({ path }) }) }) as unknown as ExecutionContext;

const estado = (over: Partial<EstadoRls> = {}): EstadoRls => ({
  rol: 'postgres',
  superusuario: true,
  bypassrls: false,
  seSalta: true,
  verificado: true,
  ...over,
});

describe('negarse a servir sin aislamiento (issue 227)', () => {
  it('en producción, con la conexión equivocada, no sirve y lo explica', () => {
    const guard = new AislamientoGuard(() => estado(), 'production');
    try {
      guard.canActivate(contexto('/v1/conversations'));
      throw new Error('debió cortar');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      const cuerpo = (err as ServiceUnavailableException).getResponse() as { code: string; message: string };
      expect(cuerpo.code).toBe('SIN_AISLAMIENTO');
      expect(cuerpo.message).toContain('rol de aplicación');
    }
  });

  it('pero salud y documentación siguen abiertas: son las que dejan diagnosticar', () => {
    const guard = new AislamientoGuard(() => estado(), 'production');
    for (const path of ['/health', '/ready', '/docs', '/metrics']) {
      expect(guard.canActivate(contexto(path))).toBe(true);
    }
  });

  it('"no pudimos preguntar" NO es "está mal": sirve igual', () => {
    const guard = new AislamientoGuard(
      () => estado({ verificado: false, seSalta: false, rol: 'desconocido', superusuario: false }),
      'production',
    );
    expect(guard.canActivate(contexto('/v1/conversations'))).toBe(true);
  });

  it('sin base configurada tampoco corta', () => {
    const guard = new AislamientoGuard(() => null, 'production');
    expect(guard.canActivate(contexto('/v1/conversations'))).toBe(true);
  });

  it('en staging no corta: ahí no hay datos reales y bloquear impide arreglarlo', () => {
    for (const entorno of ['staging', 'development', '']) {
      const guard = new AislamientoGuard(() => estado(), entorno);
      expect(guard.canActivate(contexto('/v1/conversations'))).toBe(true);
    }
  });

  it('con el rol correcto sirve en producción, como siempre', () => {
    const guard = new AislamientoGuard(
      () => estado({ rol: 'iaxti_app', superusuario: false, seSalta: false }),
      'production',
    );
    expect(guard.canActivate(contexto('/v1/conversations'))).toBe(true);
  });
});
