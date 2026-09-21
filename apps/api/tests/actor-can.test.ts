import { describe, expect, it } from 'vitest';
import { actorCan } from '../src/authz/can';
import type { Actor } from '../src/authz/authz.guard';

const key: Actor = { userId: 'apikey:fixture', tenantId: 'fixture', role: 'APIKEY', kind: 'apikey' };

describe('los permisos internos conservan el techo de la API key (#388)', () => {
  it('acepta un permiso conocido incluido expresamente en los scopes', () => {
    expect(actorCan({ ...key, scopes: ['conversations.read_all'] }, 'conversations.read_all')).toBe(true);
  });
  it.each([undefined, [], ['conversations.reply'], ['*']])('deniega read_all sin el scope explícito: %j', scopes => {
    expect(actorCan({ ...key, scopes }, 'conversations.read_all')).toBe(false);
  });
  it('un scope desconocido no crea un permiso', () => {
    expect(actorCan({ ...key, scopes: ['permiso.inventado'] }, 'permiso.inventado')).toBe(false);
  });
  it('una key no hereda privilegios de un rol humano adjunto', () => {
    expect(actorCan({ ...key, role: 'ADMIN', scopes: [] }, 'conversations.read_all')).toBe(false);
  });
  it('un humano conserva su rol y no hereda scopes adjuntos', () => {
    expect(actorCan({ ...key, kind: 'user', role: 'USER', scopes: ['conversations.read_all'] }, 'conversations.read_all')).toBe(false);
    expect(actorCan({ ...key, kind: 'user', role: 'ADMIN', scopes: [] }, 'conversations.read_all')).toBe(true);
  });
});
