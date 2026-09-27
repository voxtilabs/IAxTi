import { attachmentKey, presignPutUrl } from '@iaxti/core';
import type { StorageConfig } from '@iaxti/core';
import { fetchMediaBytes, type ZavuConfig } from './zavu';

// Adjuntos de WhatsApp (#42, SPEC §11/§36): Meta los EXPIRA — se descargan
// al llegar y van a R2 con prefijo por tenant. En Postgres, solo la llave.

export interface AdjuntoEntrante {
  url?: string;
  contentType?: string;
  name?: string;
}

export interface AdjuntoGuardado {
  key: string;
  contentType: string;
  name: string;
}

export async function downloadAttachmentsToR2(
  input: {
    tenantId: string;
    conversationId: string;
    attachments: AdjuntoEntrante[];
    apiKey: string;
    storage: StorageConfig;
  },
  config: ZavuConfig = {},
): Promise<AdjuntoGuardado[]> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const guardados: AdjuntoGuardado[] = [];
  for (const adjunto of input.attachments) {
    if (!adjunto.url) continue;
    const { bytes, contentType } = await fetchMediaBytes(adjunto.url, input.apiKey, config);
    const name = adjunto.name ?? adjunto.url.split('/').pop() ?? 'adjunto';
    const key = attachmentKey(input.tenantId, input.conversationId, name);
    const tipo = adjunto.contentType ?? contentType;
    // Acá la URL no sale de este proceso —bajamos los bytes y los subimos
    // nosotros—, así que el riesgo del permiso en blanco es bajo. Se firma tipo
    // y tamaño igual, por dos razones: tenemos los bytes en la mano, así que el
    // largo exacto es gratis; y que las TRES puertas que firman un PUT lo hagan
    // del mismo modo es lo que evita que la próxima se escriba con la insegura,
    // copiando de la que quedó.
    const subida = await fetchImpl(
      presignPutUrl(input.storage, key, { contentType: tipo, contentLength: bytes.byteLength }),
      {
        method: 'PUT',
        headers: { 'Content-Type': tipo, 'Content-Length': String(bytes.byteLength) },
        body: bytes,
      },
    );
    if (!subida.ok) throw new Error(`No pudimos guardar el adjunto en el almacenamiento: HTTP ${subida.status}`);
    guardados.push({ key, contentType: tipo, name });
  }
  return guardados;
}
