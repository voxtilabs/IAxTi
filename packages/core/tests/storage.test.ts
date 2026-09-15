import { describe, expect, it } from 'vitest';
import { attachmentKey, firmaPresignada, presignUrl, type StorageConfig } from '../src/storage';

const config: StorageConfig = {
  endpoint: 'https://cuenta.r2.cloudflarestorage.com',
  bucket: 'iaxti-staging-adjuntos',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'secreto',
};

describe('SigV4 contra el vector publicado por AWS', () => {
  /**
   * Una firma que solo se compara consigo misma puede estar mal y pasar
   * todos los tests: el error aparece el día que un cliente manda una foto
   * y R2 responde 403. Este es el ejemplo documentado por AWS ("Create a
   * presigned URL", GET de test.txt en examplebucket), con su firma
   * esperada — conocida de antemano y ajena a nuestro código.
   */
  it('reproduce la firma esperada del ejemplo oficial', () => {
    const { signature } = firmaPresignada({
      method: 'GET',
      host: 'examplebucket.s3.amazonaws.com',
      canonicalUri: '/test.txt',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      amzDate: '20130524T000000Z',
      expiresSeconds: 86400,
    });
    expect(signature).toBe('aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
  });

  it('cambiar cualquier entrada cambia la firma', () => {
    const base = {
      method: 'GET' as const,
      host: 'examplebucket.s3.amazonaws.com',
      canonicalUri: '/test.txt',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      amzDate: '20130524T000000Z',
      expiresSeconds: 86400,
    };
    const original = firmaPresignada(base).signature;
    for (const cambio of [
      { method: 'PUT' as const },
      { canonicalUri: '/otro.txt' },
      { region: 'auto' },
      { amzDate: '20130525T000000Z' },
      { expiresSeconds: 900 },
      { secretAccessKey: 'otro-secreto' },
      { host: 'otro.host' },
    ]) {
      expect(firmaPresignada({ ...base, ...cambio }).signature).not.toBe(original);
    }
  });
});

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
