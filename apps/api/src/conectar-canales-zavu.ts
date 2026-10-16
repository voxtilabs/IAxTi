import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { Pool } from 'pg';
import { withTenant } from '@iaxti/db';
import {
  createChannelAccount, emisorAcreditado, emisoresAcreditados, listChannelAccounts,
  reservarEmisor, setChannelState,
} from '@iaxti/module-channels';
import { writeAudit } from '@iaxti/module-audit';
import { clienteZavu, consultarSender, llaveSirveParaAmbiente, quienSoy, urlWebhook, type LlamarZavu } from '@iaxti/module-whatsapp';
import type { Actor } from './authz/authz.guard';

type CanalMeta = 'instagram' | 'messenger';
type Cliente = (key: string) => LlamarZavu;

function llave(ref: string | null): string {
  const valor = ref ? process.env[ref] : undefined;
  if (!valor) throw new ServiceUnavailableException({ code: 'CREDENTIAL_MISSING', message: 'Falta una credencial de esta conexión. Pide a quien configura el servicio que revise sus referencias.' });
  return valor;
}

async function consultar(llamar: LlamarZavu, senderId: string) {
  try { return await consultarSender(llamar, senderId); }
  catch { throw new ServiceUnavailableException({ code: 'PROVIDER_UNAVAILABLE', message: 'No pudimos comprobar este emisor con Zavu. Intenta de nuevo en unos minutos.' }); }
}

/** No se consulta ni entrega el catálogo global de un proyecto compartido. */
export async function conexionesDisponibles(pool: Pool, tenantId: string, cliente: Cliente = clienteZavu) {
  const { emisores, cuentas } = await withTenant(pool, tenantId, async (c) => ({
    emisores: await emisoresAcreditados(c, tenantId), cuentas: await listChannelAccounts(c, tenantId),
  }));
  const opciones = [];
  for (const { senderId, cuenta } of emisores) {
    const sender = await consultar(cliente(llave(cuenta.credentialRef)), senderId);
    for (const kind of ['instagram', 'messenger'] as const) {
      if (!sender.channels.includes(kind)) continue;
      if (cuentas.some((a) => a.config.senderId === senderId && a.kind === kind && ['active', 'degraded'].includes(a.state))) continue;
      opciones.push({ senderId, kind, name: sender.name });
    }
  }
  return opciones;
}

/** La red se consulta fuera de la transacción; reserva, cuenta y audit juntos. */
export async function conectarCanalMeta(
  pool: Pool,
  input: { actor: Actor; senderId: string; kind: CanalMeta; requestId?: string },
  cliente: Cliente = clienteZavu,
) {
  const { actor } = input;
  const original = await withTenant(pool, actor.tenantId, (c) => emisorAcreditado(c, actor.tenantId, input.senderId));
  if (!original) throw new NotFoundException({ code: 'SENDER_NOT_FOUND', message: 'Este emisor no está acreditado para tu negocio. Pide a quien configura el canal que complete su conexión.' });
  const llamar = cliente(llave(original.credentialRef));
  llave(original.webhookSecretRef);
  const sender = await consultar(llamar, input.senderId);
  if (!sender.channels.includes(input.kind)) throw new BadRequestException({ code: 'CHANNEL_NOT_CONFIGURED', message: 'Ese canal aún no está activo en Zavu. Completa su configuración y vuelve a intentarlo.' });
  const base = process.env.API_URL_PUBLIC;
  if (!base || sender.webhook?.url !== urlWebhook(base, original.id) || sender.webhook.active !== true) {
    throw new BadRequestException({ code: 'WEBHOOK_NOT_CONFIGURED', message: 'Zavu aún no tiene el webhook de esta conexión activo. Pide a quien configura el servicio que lo revise.' });
  }
  let proyecto;
  try { proyecto = await quienSoy(llamar); }
  catch { throw new ServiceUnavailableException({ code: 'PROVIDER_UNAVAILABLE', message: 'No pudimos comprobar el ambiente de la conexión. Intenta de nuevo.' }); }
  const ambiente = llaveSirveParaAmbiente(proyecto, process.env.IAXTI_ENV, original.config.enviosReales === true);
  if (!ambiente.ok) throw new BadRequestException({ code: 'CHANNEL_ENVIRONMENT_MISMATCH', message: ambiente.motivo });
  return withTenant(pool, actor.tenantId, async (c) => {
    // Serializa activaciones concurrentes antes de leer/crear la cuenta.
    const vigente = await emisorAcreditado(c, actor.tenantId, input.senderId, true);
    if (!vigente || vigente.id !== original.id || vigente.credentialRef !== original.credentialRef || vigente.webhookSecretRef !== original.webhookSecretRef) {
      throw new BadRequestException({ code: 'CONNECTION_CHANGED', message: 'La conexión cambió mientras la comprobábamos. Actualiza la lista e intenta de nuevo.' });
    }
    const cuentas = await listChannelAccounts(c, actor.tenantId);
    let cuenta = cuentas.find((a) => a.kind === input.kind && a.config.senderId === input.senderId && a.state !== 'disconnected');
    if (cuenta && ['active', 'degraded'].includes(cuenta.state)) return cuenta;
    cuenta ??= await createChannelAccount(c, {
      tenantId: actor.tenantId, kind: input.kind, name: sender.name,
      credentialRef: vigente.credentialRef!, webhookSecretRef: vigente.webhookSecretRef!,
      config: { senderId: input.senderId, ...(vigente.config.enviosReales === true ? { enviosReales: true } : {}) },
    });
    await reservarEmisor(c, { tenantId: actor.tenantId, senderId: input.senderId, accountId: cuenta.id,
      actor: actor.userId, actorKind: actor.kind === 'soporte' ? 'superadmin' : actor.kind ?? 'user', requestId: input.requestId });
    const activa = await setChannelState(c, { tenantId: actor.tenantId, accountId: cuenta.id, state: 'active', requestId: input.requestId });
    await writeAudit(c, {
      tenantId: actor.tenantId, actor: actor.userId, actorKind: actor.kind === 'soporte' ? 'superadmin' : actor.kind ?? 'user',
      action: 'channel.connected', resource: 'channel_account', resourceId: cuenta.id, result: 'ok',
      metadata: { kind: input.kind, senderId: input.senderId, webhookAccountId: original.id }, requestId: input.requestId,
    });
    return activa;
  });
}
