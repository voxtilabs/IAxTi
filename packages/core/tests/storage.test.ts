import { describe, expect, it } from 'vitest';
import { attachmentKey, presignUrl, type StorageConfig } from '../src/storage';

const config: StorageConfig = {
  endpoint: 'https://cuenta.r2.cloudflarestorage.com',
  bucket: 'iaxti-staging-adjuntos',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'secreto',
};

describe('adjuntos en R2 (SPEC §36/§40)', () => {
  it('la llave nace bajo el tenant y sanea el nombre', () => {
    const key = attachmentKey('t-1', 'c-2', 'presupuesto final (v2).pdf');
    expect(key.startsWith('t-1/c-2/')).toBe(true);
    expect(key).toMatch(/presupuesto_final__v2_\.pdf$/);
    expect(key).not.toContain(' ');
  });

  it('prefirma con SigV4 query: firma estable y distinta por método', () => {
    const ahora = new Date('2026-09-14T12:00:00Z');
    const url = presignUrl(config, 'PUT', 't-1/c-2/archivo.pdf', 900, ahora);
    const u = new URL(url);
    expect(u.origin).toBe(config.endpoint);
    expect(u.pathname).toBe('/iaxti-staging-adjuntos/t-1/c-2/archivo.pdf');
    expect(u.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(u.searchParams.get('X-Amz-Credential')).toBe('AKIDEXAMPLE/20260914/auto/s3/aws4_request');
    expect(u.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(u.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(u.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);

    // Determinista con el mismo instante; distinta para GET.
    expect(presignUrl(config, 'PUT', 't-1/c-2/archivo.pdf', 900, ahora)).toBe(url);
    const get = new URL(presignUrl(config, 'GET', 't-1/c-2/archivo.pdf', 900, ahora));
    expect(get.searchParams.get('X-Amz-Signature')).not.toBe(u.searchParams.get('X-Amz-Signature'));
  });
});
