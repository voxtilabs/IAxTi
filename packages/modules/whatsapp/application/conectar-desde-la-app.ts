import type { PoolClient } from 'pg';
import type { GoogleSecretStore } from '@iaxti/google';
import type { ActorKind } from '@iaxti/module-audit';
import {
  PREFIJO_CUSTODIA,
  fijarSecretosDelCanal,
  idDeSecretoDelCanal,
  idEnLaReferencia,
  listChannelAccounts,
  referenciaEnCustodia,
  setChannelState,
  type ChannelAccountRef,
} from '@iaxti/module-channels';
import { llamarAZernio, type ConfigDeZernio } from './zernio-base';
import {
  ErrorDelAlta,
  cuentaDeZernioYaConectada,
  cuentaDelPerfil,
  darDeAltaCuentaDeZernio,
  enlaceParaConectar,
  listarCuentasDelPerfil,
  llaveDelTenant,
  perfilDelTenant,
  perfilExistenteDelTenant,
  suscribirWebhook,
} from './zernio-perfil';

/**
 * Conectar WhatsApp desde la app (#1393, ADR-0038).
 *
 * Es `scripts/conectar-zernio.mjs` hecho caso de uso, con UNA diferencia que
 * es toda la razón de ser: la llave del negocio y el secreto del webhook no se
 * imprimen para pegarlos en el despliegue. Van de Zernio a la custodia cifrada
 * (ADR-0028), y la cuenta guarda solo la referencia. Ningún secreto vuelve al
 * navegador ni toca la base.
 *
 * Tres pasos, como en la pantalla:
 *
 * 1. `enlace`: el perfil de Zernio del negocio y el enlace de Meta.
 * 2. `numeros`: lo que el negocio dejó conectado en SU perfil.
 * 3. `conectar`: el alta del número elegido.
 *
 * La llave del OPERADOR (`ZERNIO_API_KEY`) la pone quien llama y nunca sale
 * del servidor: con ella se crea la llave restringida del negocio, que es la
 * única que se guarda.
 */
export interface DependenciasDelAlta {
  /** Con la llave del operador, no la del negocio. */
  zernio: ConfigDeZernio;
  custodia: GoogleSecretStore;
  /** Corre `fn` en una transacción con el tenant fijado (RLS). */
  conTenant: <T>(tenantId: string, fn: (c: PoolClient) => Promise<T>) => Promise<T>;
  /** La URL pública de la API: ahí apunta el webhook de la cuenta. */
  baseUrlApi: string;
  /**
   * El ambiente, para la regla de #593: un número de Zernio manda de verdad,
   * y fuera de producción eso se declara (`ZERNIO_ENVIOS_REALES=1`), nunca se
   * finge con `IAXTI_ENV`.
   */
  ambiente: { produccion: boolean; enviosRealesDeclarados: boolean };
}

function exigirAmbiente(deps: DependenciasDelAlta): { enviosReales: boolean } {
  if (deps.ambiente.produccion) return { enviosReales: false };
  if (!deps.ambiente.enviosRealesDeclarados) {
    throw new ErrorDelAlta(
      'En este ambiente no se conectan números reales: lo que escribas saldría a clientes de verdad. ' +
        'Si es lo que quieres, pide que declaren ZERNIO_ENVIOS_REALES=1 en el despliegue.',
    );
  }
  return { enviosReales: true };
}

/**
 * Paso 1: el enlace para conectar el número EN el perfil de este negocio.
 *
 * `modo` (#1405) es la respuesta de la dueña ANTES de ir a Meta: si el número
 * vive en la app WhatsApp Business del teléfono (`coexistencia`) o si es un
 * número nuevo o solo para IAxTi (`api`). Zernio asume coexistencia cuando el
 * enlace no lo dice, y un número que no está en la app entra al flujo
 * equivocado de Meta: por eso el modo es obligatorio y se traduce al
 * `onboarding` de la spec (`business_app` / `api`).
 */
export async function enlaceParaConectarDesdeLaApp(
  deps: DependenciasDelAlta,
  input: { tenantId: string; nombreDelNegocio: string; modo: 'coexistencia' | 'api'; volverA?: string },
): Promise<{ url: string }> {
  exigirAmbiente(deps);
  const { perfil } = await perfilDelTenant(deps.zernio, { tenantId: input.tenantId, nombre: input.nombreDelNegocio });
  const url = await enlaceParaConectar(deps.zernio, {
    profileId: perfil._id,
    modo: input.modo === 'coexistencia' ? 'business_app' : 'api',
    ...(input.volverA ? { redirectUrl: input.volverA } : {}),
  });
  return { url };
}

export interface NumeroParaConectar {
  /** El id de la cuenta en Zernio: público, se comprueba de nuevo al conectar. */
  cuenta: string;
  nombre: string;
  pideReconectar: boolean;
  /**
   * Ya es un canal de IAxTi que funciona. Uno que quedó en `connecting` —un
   * alta que se cortó— NO cuenta: tiene que seguir en la lista para poder
   * terminarlo.
   */
  yaConectado: boolean;
}

/** Paso 2: los WhatsApp que el negocio dejó en su perfil. No crea nada. */
export async function numerosParaConectar(
  deps: DependenciasDelAlta,
  input: { tenantId: string },
): Promise<NumeroParaConectar[]> {
  const perfil = await perfilExistenteDelTenant(deps.zernio, input.tenantId);
  if (!perfil) return [];
  const cuentas = (await listarCuentasDelPerfil(deps.zernio, perfil._id)).filter((c) => c.platform === 'whatsapp');
  const canales = await deps.conTenant(input.tenantId, (c) => listChannelAccounts(c, input.tenantId));
  return cuentas.map((c) => ({
    cuenta: c._id,
    nombre: c.displayName ?? c.username ?? 'WhatsApp',
    pideReconectar: Boolean(c.needsReconnection),
    yaConectado: canales.some(
      (a) =>
        a.provider === 'zernio' &&
        a.config.zernioAccountId === c._id &&
        a.state !== 'disconnected' &&
        a.state !== 'connecting',
    ),
  }));
}

/** Solo si parece un teléfono: el nombre visible de la cuenta no lo es. */
function telefonoVisible(...valores: Array<string | undefined>): string | undefined {
  return valores.find((v) => /^\+?\d[\d\s-]{6,}$/.test(v ?? ''));
}

/**
 * Paso 3: el alta del número.
 *
 * El orden importa y cada paso es repetible:
 *
 * 1. Se comprueba que la cuenta esté en el perfil de ESTE negocio (#1321).
 * 2. Transacción 1: la cuenta de canal, en `connecting` y sin referencias —el
 *    webhook necesita su id—. Si ya existía, se reusa.
 * 3. Zernio: la llave restringida al perfil y el webhook atado a la cuenta.
 * 4. Custodia: los dos secretos, cifrados.
 * 5. Transacción 2: la cuenta apunta a ellos y se activa, auditado.
 * 6. Recién entonces se destruyen los secretos anteriores de la custodia.
 *
 * Si algo falla entre 2 y 5, la cuenta queda en `connecting` —no manda ni
 * recibe— y volver a conectar la termina. Lo que alcanzó a guardarse en la
 * custodia se borra; la llave nueva de Zernio también.
 */
export async function conectarNumeroDesdeLaApp(
  deps: DependenciasDelAlta,
  input: {
    tenantId: string;
    cuenta: string;
    nombre?: string;
    /**
     * Cómo usa el negocio ese número hoy (#1405). Si viene, la cuenta queda
     * con `config.coexistencia` —un dato público, no secreto— para que
     * Canales y el paso del historial sepan qué tipo de conexión es. Sin él
     * no se escribe el campo: el criterio honesto es lo que la dueña eligió
     * en la pantalla, no lo que adivinemos del proveedor.
     */
    modo?: 'coexistencia' | 'api';
    actor: string;
    actorKind: ActorKind;
    requestId?: string;
  },
): Promise<{ account: ChannelAccountRef; renovada: boolean }> {
  const { enviosReales } = exigirAmbiente(deps);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.cuenta)) {
    throw new ErrorDelAlta('Ese número no es uno de los que conectaste. Vuelve a abrir el enlace para conectar.');
  }
  const perfil = await perfilExistenteDelTenant(deps.zernio, input.tenantId);
  if (!perfil) {
    throw new ErrorDelAlta('Todavía no conectaste ningún número. Abre el enlace para conectar y vuelve aquí.');
  }
  const cuentaZ = await cuentaDelPerfil(deps.zernio, {
    profileId: perfil._id,
    zernioAccountId: input.cuenta,
    plataforma: 'whatsapp',
  });

  let renovada = true;
  const cuenta = await deps.conTenant(input.tenantId, async (c) => {
    const ya = await cuentaDeZernioYaConectada(c, input.tenantId, input.cuenta);
    if (ya) return ya;
    renovada = false;
    const telefono = telefonoVisible(cuentaZ.displayName, cuentaZ.username);
    const { account } = await darDeAltaCuentaDeZernio(c, {
      tenantId: input.tenantId,
      nombre: input.nombre?.trim() || 'WhatsApp',
      zernioAccountId: input.cuenta,
      zernioProfileId: perfil._id,
      ...(telefono ? { displayPhone: telefono } : {}),
      ...(input.modo ? { coexistencia: input.modo === 'coexistencia' } : {}),
      activar: false,
      enviosReales,
      actor: input.actor,
      actorKind: input.actorKind,
      ...(input.requestId ? { requestId: input.requestId } : {}),
    }).catch((e: unknown) => {
      // El tope del plan, «ese número ya está conectado», «ese emisor es de
      // otro negocio»: `connectWhatsAppNumber` los lanza como `Error` con la
      // frase para la persona. Un error de Postgres trae `code` y NO es para
      // la pantalla: sigue como está y lo cuenta el filtro global.
      if (e instanceof Error && !('code' in e)) throw new ErrorDelAlta(e.message);
      throw e;
    });
    return account;
  });

  const llave = await llaveDelTenant(deps.zernio, { tenantId: input.tenantId, profileId: perfil._id });
  const guardadas: string[] = [];
  try {
    const url = `${deps.baseUrlApi.replace(/\/+$/, '')}/webhooks/channels/${cuenta.id}`;
    const webhook = await suscribirWebhook(deps.zernio, { url, profileId: perfil._id, zernioAccountId: input.cuenta });

    const refLlave = await deps.custodia.put(idDeSecretoDelCanal(input.tenantId, cuenta.id, 'llave'), llave.llave);
    guardadas.push(refLlave);
    const refWebhook = await deps.custodia.put(idDeSecretoDelCanal(input.tenantId, cuenta.id, 'webhook'), webhook.secreto);
    guardadas.push(refWebhook);

    const { antes, account } = await deps.conTenant(input.tenantId, async (c) => {
      const fijado = await fijarSecretosDelCanal(c, {
        tenantId: input.tenantId,
        accountId: cuenta.id,
        credentialRef: `${PREFIJO_CUSTODIA}${refLlave}`,
        webhookSecretRef: `${PREFIJO_CUSTODIA}${refWebhook}`,
        actor: input.actor,
        actorKind: input.actorKind,
        ...(input.requestId ? { requestId: input.requestId } : {}),
      });
      const activa =
        cuenta.state === 'connecting'
          ? await setChannelState(c, {
              tenantId: input.tenantId,
              accountId: cuenta.id,
              state: 'active',
              ...(input.requestId ? { requestId: input.requestId } : {}),
            })
          : { ...cuenta, credentialRef: `${PREFIJO_CUSTODIA}${refLlave}` };
      return { antes: fijado.antes, account: activa };
    });
    guardadas.length = 0; // Ya son de la cuenta: no se borran.

    // Los secretos anteriores de la custodia, una vez confirmado lo nuevo.
    // Solo los que eran de ESTA cuenta; uno del entorno no es nuestro de borrar.
    await Promise.all([
      destruirSiEsDeLaCuenta(deps.custodia, antes.credentialRef, input.tenantId, cuenta.id, 'llave'),
      destruirSiEsDeLaCuenta(deps.custodia, antes.webhookSecretRef, input.tenantId, cuenta.id, 'webhook'),
    ]);
    return { account, renovada };
  } catch (err) {
    // Lo que alcanzó a guardarse no queda huérfano, y la llave de Zernio
    // que nadie va a usar tampoco queda viva.
    await Promise.all(guardadas.map((ref) => borrarSecreto(deps.custodia, ref)));
    await llamarAZernio(deps.zernio, `/v1/api-keys/${encodeURIComponent(llave.id)}`, { method: 'DELETE' }).catch(
      () => undefined,
    );
    throw err;
  }
}

async function destruirSiEsDeLaCuenta(
  custodia: GoogleSecretStore,
  ref: string | null,
  tenantId: string,
  accountId: string,
  cual: 'llave' | 'webhook',
): Promise<void> {
  const referencia = referenciaEnCustodia(ref, tenantId, accountId, cual);
  if (referencia) await borrarSecreto(custodia, referencia);
}

async function borrarSecreto(custodia: GoogleSecretStore, referencia: string): Promise<void> {
  const id = idEnLaReferencia(referencia);
  if (!id) return;
  await custodia.deleteSecret(id).catch((err) => {
    // No se pierde nada: es un secreto que ya nadie referencia. Queda en el log.
    console.warn(`[canales] no se pudo borrar un secreto viejo de la custodia: ${(err as Error).name}`);
  });
}
