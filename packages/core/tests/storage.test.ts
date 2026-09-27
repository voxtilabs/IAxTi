import { describe, expect, it } from 'vitest';
import {
  almacenR2,
  attachmentKey,
  firmaPresignada,
  presignPutUrl,
  presignUrl,
  type StorageConfig,
} from '../src/storage';

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

describe('la URL de subida amarra tipo y tamaño', () => {
  /**
   * Una URL prefirmada de PUT que solo firma `host` es un permiso en blanco:
   * lo que el servidor revise antes de firmar (que sea PDF, que pese menos de
   * 10 MB) no viaja en la URL, y quien la tenga sube lo que quiera del tamaño
   * que quiera — y el almacenamiento y el egreso los paga la cuenta. El límite
   * tiene que estar DENTRO de la firma.
   */
  const ahora = new Date('2026-09-14T12:00:00Z');

  it('firma content-type y content-length además de host', () => {
    const u = new URL(
      presignPutUrl(config, 't-1/conocimiento/lista.pdf', {
        contentType: 'application/pdf',
        contentLength: 1_048_576,
        now: ahora,
      }),
    );
    expect(u.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
    expect(u.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('otro tamaño u otro tipo es otra firma: con la URL en la mano no se sube otra cosa', () => {
    const base = { contentType: 'application/pdf', contentLength: 1_048_576, now: ahora };
    const firma = (url: string) => new URL(url).searchParams.get('X-Amz-Signature');
    const original = firma(presignPutUrl(config, 't-1/conocimiento/lista.pdf', base));

    // 5 GB en vez de 1 MB: otra firma, y R2 la rechaza con 403.
    expect(
      firma(
        presignPutUrl(config, 't-1/conocimiento/lista.pdf', { ...base, contentLength: 5_368_709_120 }),
      ),
    ).not.toBe(original);
    // Un ejecutable disfrazado de PDF: otra firma también.
    expect(
      firma(
        presignPutUrl(config, 't-1/conocimiento/lista.pdf', {
          ...base,
          contentType: 'application/octet-stream',
        }),
      ),
    ).not.toBe(original);
    // Y la URL sin límites (la de antes) no es la misma que la acotada.
    expect(firma(presignUrl(config, 'PUT', 't-1/conocimiento/lista.pdf', 900, ahora))).not.toBe(
      original,
    );
  });

  it('sin tipo o sin tamaño no se firma nada', () => {
    expect(() =>
      presignPutUrl(config, 't-1/x.pdf', { contentType: '', contentLength: 10, now: ahora }),
    ).toThrow(/tipo de archivo/);
    expect(() =>
      presignPutUrl(config, 't-1/x.pdf', {
        contentType: 'application/pdf',
        contentLength: 0,
        now: ahora,
      }),
    ).toThrow(/tamaño/);
  });
});

describe('borrar objetos del bucket (Ley 21.719 y retención)', () => {
  it('manda un DELETE firmado por llave y trata el 404 como borrado', async () => {
    const pedidos: Array<{ url: string; method?: string }> = [];
    const fetchFalso = (async (url: string | URL, init?: { method?: string }) => {
      pedidos.push({ url: String(url), method: init?.method });
      // El segundo objeto ya no estaba: para un borrado eso es éxito, y es lo
      // que hace seguro reintentar una supresión que quedó a medio camino.
      const primero = pedidos.length === 1;
      return { ok: primero, status: primero ? 204 : 404 };
    }) as unknown as typeof fetch;

    const almacen = almacenR2(config, fetchFalso)!;
    const res = await almacen.borrar(['t-1/c-2/boleta.jpg', 't-1/c-2/ida.pdf', 't-1/c-2/boleta.jpg']);
    expect(res.borradas).toEqual(['t-1/c-2/boleta.jpg', 't-1/c-2/ida.pdf']);
    expect(res.fallidas).toEqual([]);
    // La llave repetida se pide una sola vez.
    expect(pedidos).toHaveLength(2);
    expect(pedidos[0].method).toBe('DELETE');
    expect(pedidos[0].url).toContain('X-Amz-Signature=');
  });

  it('lo que el bucket rechaza queda como fallido, no como borrado', async () => {
    const fetchFalso = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
    const almacen = almacenR2(config, fetchFalso)!;
    const res = await almacen.borrar(['t-1/c-2/boleta.jpg']);
    expect(res.borradas).toEqual([]);
    expect(res.fallidas).toEqual(['t-1/c-2/boleta.jpg']);
  });

  it('sin almacenamiento configurado devuelve null: quien llama decide qué hacer', () => {
    expect(almacenR2(null)).toBeNull();
  });
});
