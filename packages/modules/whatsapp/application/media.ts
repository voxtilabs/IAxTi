import { attachmentKey, presignUrl } from '@iaxti/core';
import type { StorageConfig } from '@iaxti/core';
import { fetchMediaBytes, type KapsoConfig } from './kapso';

// Adjuntos de WhatsApp (#42, SPEC §11/§36): Meta los EXPIRA — se descargan
// al llegar y van a R2 con prefijo por tenant. En Postgres, solo la llave.

export interface AdjuntoEntrante {
  mediaId?: string;
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
  config: KapsoConfig = {},
): Promise<AdjuntoGuardado[]> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const guardados: AdjuntoGuardado[] = [];
  for (const adjunto of input.attachments) {
    if (!adjunto.mediaId) continue;
    const { bytes, contentType } = await fetchMediaBytes(adjunto.mediaId, input.apiKey, config);
    const name = adjunto.name ?? adjunto.mediaId;
    const key = attachmentKey(input.tenantId, input.conversationId, name);
    const subida = await fetchImpl(presignUrl(input.storage, 'PUT', key), {
      method: 'PUT',
      headers: { 'Content-Type': adjunto.contentType ?? contentType },
      body: bytes,
    });
    if (!subida.ok) throw new Error(`No pudimos guardar el adjunto en el almacenamiento: HTTP ${subida.status}`);
    guardados.push({ key, contentType: adjunto.contentType ?? contentType, name });
  }
  return guardados;
}
