/**
 * Los límites de un adjunto, por canal y por clase de archivo (#560).
 *
 * Antes no se revisaba nada: la ruta que firma la URL de subida solo pedía el
 * nombre del archivo. Un video de 40 MB se subía a R2 —que se paga— y recién el
 * proveedor lo rechazaba, así que quien atiende esperaba la barra de progreso
 * para leer que el mensaje falló.
 *
 * Vive en `channels` y no en `whatsapp` aunque los números sean de WhatsApp: el
 * dueño de la pregunta «qué acepta este canal» es quien define qué es un canal.
 * Si la tabla viviera en `whatsapp`, la bandeja tendría que depender de que
 * WhatsApp esté instalado para saber cuánto pesa un archivo en webchat.
 *
 * Y vive en UN solo lugar a propósito: dos copias —una en la API y otra en la
 * interfaz— se separan en el primer cambio, y entonces la interfaz promete lo
 * que la API rechaza. La interfaz los PIDE; no los copia.
 *
 * Fuente de los números: límites de la Cloud API de WhatsApp para media.
 */

export type ClaseDeAdjunto = 'imagen' | 'audio' | 'video' | 'documento' | 'sticker';

export interface LimiteDeAdjunto {
  clase: ClaseDeAdjunto;
  /** Cómo se lo nombra en un aviso: «Esa imagen pesa…». */
  nombre: string;
  maxBytes: number;
  /** Tipos MIME aceptados. La lista es cerrada: lo que no está, no sale. */
  tipos: readonly string[];
}

const MB = 1024 * 1024;

export const LIMITES_WHATSAPP: readonly LimiteDeAdjunto[] = [
  {
    clase: 'imagen',
    nombre: 'imagen',
    maxBytes: 5 * MB,
    tipos: ['image/jpeg', 'image/png'],
  },
  {
    clase: 'sticker',
    nombre: 'sticker',
    // El animado admite 500 KB, pero desde acá no se puede saber si lo es sin
    // abrir el archivo. Se usa el límite del estático, que es el que siempre
    // pasa: quedarse corto avisa; quedarse largo deja subir algo que no sale.
    maxBytes: 100 * 1024,
    tipos: ['image/webp'],
  },
  {
    clase: 'audio',
    nombre: 'audio',
    maxBytes: 16 * MB,
    tipos: ['audio/aac', 'audio/amr', 'audio/mpeg', 'audio/mp4', 'audio/ogg'],
  },
  {
    clase: 'video',
    nombre: 'video',
    maxBytes: 16 * MB,
    tipos: ['video/mp4', 'video/3gp', 'video/3gpp'],
  },
  {
    clase: 'documento',
    nombre: 'documento',
    maxBytes: 100 * MB,
    tipos: [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'text/plain',
      'text/csv',
    ],
  },
];

/**
 * Lo que se usa cuando un canal no declaró su tabla.
 *
 * Es la MÁS restrictiva y no la más permisiva, y esa asimetría es la decisión:
 * si nos equivocamos por abajo, alguien se entera de que su archivo es grande
 * antes de subirlo; si nos equivocamos por arriba, lo sube, se paga y falla.
 */
export const LIMITES_CONSERVADORES: readonly LimiteDeAdjunto[] = LIMITES_WHATSAPP.map((l) => ({
  ...l,
  maxBytes: Math.min(l.maxBytes, 8 * MB),
}));

/** Canales cuyo transporte declara la tabla de WhatsApp. */
const CON_TABLA_DE_WHATSAPP = new Set(['whatsapp']);

export function limitesDelCanal(canal: string): readonly LimiteDeAdjunto[] {
  return CON_TABLA_DE_WHATSAPP.has(canal) ? LIMITES_WHATSAPP : LIMITES_CONSERVADORES;
}

/** A qué clase pertenece un tipo MIME, o null si el canal no lo acepta. */
export function claseDeAdjunto(
  contentType: string,
  canal = 'whatsapp',
): LimiteDeAdjunto | null {
  const tipo = contentType.split(';')[0]!.trim().toLowerCase();
  return limitesDelCanal(canal).find((l) => l.tipos.includes(tipo)) ?? null;
}

/** MB con un decimal solo cuando hace falta: «5 MB», «1,4 MB». */
function enMB(bytes: number): string {
  const mb = bytes / MB;
  if (mb >= 1) {
    const redondo = Math.round(mb * 10) / 10;
    return `${String(redondo).replace('.', ',')} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export type RevisionDeAdjunto =
  | { ok: true; limite: LimiteDeAdjunto }
  | { ok: false; code: 'ADJUNTO_TIPO_NO_ACEPTADO' | 'ADJUNTO_MUY_GRANDE'; message: string };

/**
 * La única puerta: la usan la API antes de firmar la subida y la interfaz antes
 * de subir, con el MISMO mensaje. Si alguna vez dicen cosas distintas, es que
 * alguien se hizo una copia.
 */
export function revisarAdjunto(
  entrada: { contentType: string; sizeBytes: number },
  canal = 'whatsapp',
): RevisionDeAdjunto {
  const limite = claseDeAdjunto(entrada.contentType, canal);
  if (!limite) {
    return {
      ok: false,
      code: 'ADJUNTO_TIPO_NO_ACEPTADO',
      message:
        'Este canal no acepta ese tipo de archivo. Puedes mandar una imagen, un video, un audio o un documento.',
    };
  }
  if (entrada.sizeBytes > limite.maxBytes) {
    return {
      ok: false,
      code: 'ADJUNTO_MUY_GRANDE',
      // El límite que se nombra es el de ESA clase y no uno genérico: «el
      // máximo es 100 MB» cuando la imagen tope son 5 no ayuda a nadie.
      message: `Ese ${limite.nombre} pesa ${enMB(entrada.sizeBytes)} y el máximo de este canal es ${enMB(limite.maxBytes)}. Mándalo más liviano.`,
    };
  }
  return { ok: true, limite };
}
