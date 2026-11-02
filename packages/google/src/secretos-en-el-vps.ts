import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GoogleIntegrationError, invalidInput, type GoogleRequestOptions } from './http';
import type { GoogleSecretStore } from './secrets';

/**
 * Custodia de los tokens de Google EN EL VPS, cifrada en disco.
 *
 * ADR-0027 dice «los tokens completos viven únicamente en Secret Manager».
 * Esto es un desvío declarado y acotado a v1: ver la enmienda del ADR. El
 * puerto es el mismo (`GoogleSecretStore`), así que volver a Secret Manager
 * —o irse a otro almacén— es cambiar qué implementación inyecta
 * `calendarGoogleDesdeEntorno`, no tocar Calendar ni identity.
 *
 * ## Lo que NO cambia, y es a propósito
 *
 * La referencia conserva la forma `…/secrets/<id>/versions/<n>`. No es
 * estética: la recolección de versiones reemplazadas busca con
 *
 *     g.secret_ref LIKE '%/secrets/' || v.secret_ref || '/versions/%'
 *
 * así que una referencia con otra forma dejaría de encontrar nada **sin
 * fallar**, y los tokens viejos se quedarían en disco para siempre.
 *
 * También se conserva que los números de versión solo suben. Una versión
 * destruida deja una lápida en vez de desaparecer, porque reusar su número
 * haría que una referencia vieja apuntara a una credencial nueva.
 *
 * ## Lo que sí cambia, dicho como es
 *
 * Secret Manager da rotación, IAM y su propio registro de accesos. Acá la
 * protección es el cifrado en disco más la llave del entorno: quien pueda
 * leer el disco Y el entorno del proceso, puede leer los tokens. Para v1,
 * con la base y la aplicación en la misma máquina que ya tiene esos dos
 * accesos, no se pierde una frontera que existiera de verdad — pero el día
 * que la aplicación se reparta en varias máquinas, esto se revisa.
 *
 * El cifrado es AES-256-GCM: la etiqueta de autenticación hace de verificación
 * de integridad, que es lo que en Secret Manager hacía el CRC32C.
 */
export interface LocalSecretStoreConfig {
  /** Carpeta en un volumen que sobreviva al redespliegue. */
  directorio: string;
  /** 32 bytes en base64. Sin esto no se arranca: no hay modo «sin cifrar». */
  clave: string;
  /** El prefijo de la referencia. Queda en el dato, así que se lee de dónde vino. */
  espacio?: string;
}

const ID = /^[A-Za-z0-9_-]{1,255}$/;
const TOPE_BYTES = 65536;
/**
 * El largo de la etiqueta de GCM, FIJADO.
 *
 * Sin fijarlo, `createDecipheriv` acepta una etiqueta más corta que la que
 * escribimos, y una etiqueta corta se puede falsificar: el atacante prueba
 * hasta acertar un prefijo. Semgrep lo caza
 * (`javascript.node-crypto.security.gcm-no-tag-length`) y tiene razón —
 * acá siempre escribimos 16 bytes, así que exigirlos no cuesta nada y
 * convierte un invariante del código en uno del descifrador.
 */
const ETIQUETA = 16;
const NONCE = 12;
const SUFIJO = '.sec';
const LAPIDA = '.destruida';

export function createLocalSecretStore(
  config: LocalSecretStoreConfig,
  opciones: { ahora?: () => Date } = {},
): GoogleSecretStore {
  void opciones;
  const llave = Buffer.from(config.clave, 'base64');
  if (llave.length !== 32 || !config.directorio) {
    throw new GoogleIntegrationError('GOOGLE_CONFIGURATION_INVALID');
  }
  const espacio = config.espacio ?? 'custodia-local';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(espacio)) {
    throw new GoogleIntegrationError('GOOGLE_CONFIGURATION_INVALID');
  }

  const prefijo = `${espacio}/secrets/`;
  const carpeta = (id: string) => {
    if (!ID.test(id)) return invalidInput();
    return join(config.directorio, id);
  };
  /** Rompe una referencia en sus partes, con la misma validación que el otro almacén. */
  const partes = (ref: string) => {
    if (!ref.startsWith(prefijo)) return invalidInput();
    const resto = ref.slice(prefijo.length);
    if (!/^[A-Za-z0-9_-]{1,255}\/versions\/[1-9][0-9]{0,19}$/.test(resto)) return invalidInput();
    const [id, , n] = resto.split('/');
    return { id, n, archivo: join(config.directorio, id, `${n}${SUFIJO}`) };
  };
  const referencia = (id: string, n: number) => `${prefijo}${id}/versions/${n}`;

  /** Cortar donde el otro almacén corta: una señal ya abortada no escribe nada. */
  const vigente = (opt: GoogleRequestOptions) => {
    if (opt.signal?.aborted) throw new GoogleIntegrationError('GOOGLE_REQUEST_ABORTED');
  };

  const cifrar = (texto: string) => {
    const bytes = Buffer.from(texto, 'utf8');
    if (bytes.length === 0 || bytes.length > TOPE_BYTES) return invalidInput();
    const iv = randomBytes(NONCE);
    const cifrador = createCipheriv('aes-256-gcm', llave, iv, { authTagLength: ETIQUETA });
    const cuerpo = Buffer.concat([cifrador.update(bytes), cifrador.final()]);
    return Buffer.concat([iv, cifrador.getAuthTag(), cuerpo]);
  };

  const descifrar = (guardado: Buffer) => {
    if (guardado.length < NONCE + ETIQUETA + 1) throw new GoogleIntegrationError('GOOGLE_RESPONSE_INVALID');
    const descifrador = createDecipheriv('aes-256-gcm', llave, guardado.subarray(0, NONCE),
      { authTagLength: ETIQUETA });
    descifrador.setAuthTag(guardado.subarray(NONCE, NONCE + ETIQUETA));
    try {
      const bytes = Buffer.concat([descifrador.update(guardado.subarray(NONCE + ETIQUETA)), descifrador.final()]);
      const texto = bytes.toString('utf8');
      // Igual que el otro almacén: UTF-8 roto no se convierte en silencio en
      // otra credencial.
      if (!timingSafeEqual(Buffer.from(texto, 'utf8'), bytes)) {
        throw new GoogleIntegrationError('GOOGLE_RESPONSE_INVALID');
      }
      return texto;
    } catch (error) {
      if (error instanceof GoogleIntegrationError) throw error;
      // La etiqueta de GCM no calzó: el archivo está adulterado o la llave
      // cambió. En los dos casos, lo que NO se puede hacer es devolver algo.
      throw new GoogleIntegrationError('GOOGLE_RESPONSE_INVALID');
    }
  };

  /** Escribe y renombra: un proceso muerto a medias no deja media credencial. */
  const escribirEntero = async (destino: string, datos: Buffer) => {
    const temporal = `${destino}.${randomBytes(6).toString('hex')}.parcial`;
    await writeFile(temporal, datos, { mode: 0o600 });
    await rename(temporal, destino);
  };

  /**
   * La versión siguiente mira TAMBIÉN las lápidas: los números solo suben, así
   * que una referencia vieja nunca termina apuntando a una credencial nueva.
   */
  const siguiente = async (dir: string) => {
    const entradas = await readdir(dir).catch(() => {
      throw new GoogleIntegrationError('GOOGLE_NOT_FOUND');
    });
    let mayor = 0;
    for (const entrada of entradas) {
      const n = Number.parseInt(entrada.split('.')[0], 10);
      if (Number.isSafeInteger(n) && n > mayor) mayor = n;
    }
    return mayor + 1;
  };

  const addVersion = async (id: string, payload: string, opt: GoogleRequestOptions = {}) => {
    vigente(opt);
    const dir = carpeta(id);
    const datos = cifrar(payload);
    const n = await siguiente(dir);
    await escribirEntero(join(dir, `${n}${SUFIJO}`), datos);
    return referencia(id, n);
  };

  return {
    async put(id, payload, opt = {}) {
      vigente(opt);
      const dir = carpeta(id);
      // Validar el payload ANTES de crear nada: igual que en Secret Manager,
      // un payload inválido no puede dejar un secreto vacío detrás.
      cifrar(payload);
      try {
        await mkdir(dir, { recursive: false, mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new GoogleIntegrationError('GOOGLE_ALREADY_EXISTS');
        }
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          await mkdir(config.directorio, { recursive: true, mode: 0o700 });
          await mkdir(dir, { recursive: false, mode: 0o700 });
        } else throw error;
      }
      return addVersion(id, payload, opt);
    },

    addVersion,

    async access(ref, opt = {}) {
      vigente(opt);
      const { archivo } = partes(ref);
      const guardado = await readFile(archivo).catch(() => {
        throw new GoogleIntegrationError('GOOGLE_NOT_FOUND');
      });
      return descifrar(guardado);
    },

    async destroy(ref, opt = {}) {
      vigente(opt);
      const { archivo } = partes(ref);
      // La lápida ocupa el número para siempre y deja el borrado a la vista.
      // Si ya estaba destruida, no es un fallo: la cola de limpieza reintenta
      // y tiene que poder terminar.
      await rename(archivo, archivo.replace(new RegExp(`${SUFIJO}$`), LAPIDA)).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      });
    },

    async deleteSecret(id, opt = {}) {
      vigente(opt);
      await rm(carpeta(id), { recursive: true, force: true });
    },
  };
}

/** Lo que haría falta en el entorno para que la custodia local esté completa. */
export function custodiaLocalDesdeEntorno(
  env: NodeJS.ProcessEnv = process.env,
): GoogleSecretStore | null {
  const { GOOGLE_SECRET_DIR: directorio, GOOGLE_SECRET_KEY: clave } = env;
  if (!directorio || !clave) return null;
  return createLocalSecretStore({ directorio, clave });
}

/** Solo para las pruebas que necesitan limpiar: no se usa en producción. */
export async function olvidarSecretoLocal(directorio: string, id: string): Promise<void> {
  if (!ID.test(id)) return invalidInput();
  await unlink(join(directorio, id)).catch(() => undefined);
}

/**
 * El único lugar donde se decide DÓNDE se guarda un secreto (#1175).
 *
 * Había dos. El calendario elegía bien —disco si hay `GOOGLE_SECRET_DIR` y
 * `GOOGLE_SECRET_KEY`, Secret Manager si no— y WhatsApp llamaba derecho a
 * `createGoogleSecretStore`, así que conectar un número exigía un proyecto de
 * Google Cloud. ADR-0028 dice lo contrario: **en la v1 la custodia es el
 * disco cifrado del VPS** y Secret Manager es la opción.
 *
 * Lo que costaba: el botón «Conectar WhatsApp» devolvía 503 sin llegar a
 * pedirle la invitación a Zavu, y desde afuera parecía un problema del
 * proveedor. Zavu no tiene nada que ver con Google Cloud.
 *
 * Por qué una función y no copiar el `if`: a la tercera copia, una de las
 * tres va a quedar vieja, y el síntoma —«creo que guardo en Secret Manager y
 * estoy escribiendo en un disco efímero»— no se descubre hasta que se pierden
 * los tokens. Lo dice el comentario del calendario y es el motivo de que esto
 * viva acá.
 *
 * Devuelve `null` cuando NO hay custodia posible, y lanza cuando hay una
 * configuración a MEDIAS: un directorio sin llave no es «sin configurar», es
 * un error de despliegue que hay que decir en voz alta.
 */
export class CustodiaIncompleta extends Error {
  constructor(public readonly falta: string) {
    super(`Falta ${falta} para la custodia de secretos.`);
    this.name = 'CustodiaIncompleta';
  }
}

export function custodiaDesdeEntorno(
  crearEnLaNube: (config: { projectId: string; location: string }) => GoogleSecretStore,
  env: NodeJS.ProcessEnv = process.env,
): GoogleSecretStore | null {
  const dir = env.GOOGLE_SECRET_DIR?.trim();
  const clave = env.GOOGLE_SECRET_KEY?.trim();
  // El disco gana si hay señal de que se quiso usar, aunque esté a medias:
  // caer a Secret Manager porque falta la llave sería guardar en otro lado
  // sin que nadie lo pidiera.
  if (dir || clave) {
    if (!dir) throw new CustodiaIncompleta('GOOGLE_SECRET_DIR');
    if (!clave) throw new CustodiaIncompleta('GOOGLE_SECRET_KEY');
    return createLocalSecretStore({ directorio: dir, clave });
  }
  const projectId = env.GOOGLE_SECRET_PROJECT_ID?.trim();
  const location = env.GOOGLE_SECRET_LOCATION?.trim();
  if (!projectId && !location) return null;
  if (!projectId) throw new CustodiaIncompleta('GOOGLE_SECRET_PROJECT_ID');
  if (!location) throw new CustodiaIncompleta('GOOGLE_SECRET_LOCATION');
  return crearEnLaNube({ projectId, location });
}
