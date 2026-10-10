import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { connectWhatsAppNumber } from '@iaxti/module-whatsapp';
import { receiveInbound } from '@iaxti/module-conversations';
import { CUERPO_DE_PRUEBA, probarEnvio } from '../src/probar-envio';

/**
 * Probar el envío, y los caminos por los que no sale (#587).
 *
 * «No puedo enviar mensajes desde la bandeja», tres veces, sin poder contestar
 * ninguna. El diagnóstico que había revisa la CONFIGURACIÓN y **nada intentaba
 * enviar**, así que la única forma de saber por cuál de los caminos moría un
 * envío era tener las credenciales y mirar la cola a mano.
 *
 * Lo que estas pruebas cuidan es que cada camino diga lo SUYO. Nueve razones
 * que se ven todas iguales desde la bandeja —«no se pudo enviar»— es el issue
 * entero; si acá volvieran a confundirse dos, el diagnóstico vuelve a no servir.
 *
 * ## Dos de los nueve no existen en este camino, y es a propósito
 *
 * «La conversación no tiene canal» no puede pasar: la prueba la dispara alguien
 * que eligió el canal en la pantalla. Y «la plantilla no coincide con una
 * aprobada» tampoco: la prueba manda texto libre, no una plantilla — y por eso
 * la ventana de 24 h la rechaza en vez de dejarla salir, que es justamente el
 * diagnóstico más probable.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
let accountId: string;

/** Un despacho de mentira: lo que importa es QUÉ llega, no la red. */
function despachoFalso(
  resultado: { providerMessageId: string } | Error,
): { llamadas: Array<{ to: string; body?: string }>; despachar: never } {
  const llamadas: Array<{ to: string; body?: string }> = [];
  const despachar = (async (_cuenta: unknown, data: { to: string; body?: string }) => {
    llamadas.push({ to: data.to, ...(data.body ? { body: data.body } : {}) });
    if (resultado instanceof Error) throw resultado;
    return resultado;
  }) as never;
  return { llamadas, despachar };
}

/**
 * Una hora FIJA, de día en Chile.
 *
 * Sin esto las pruebas dependían del reloj de la máquina: el horario de
 * silencio por defecto es 21:00–08:00 en América/Santiago, así que las que
 * esperan que la prueba SALGA se ponían rojas con solo correr de noche. En CI
 * pasó a las 00:03 UTC —21:03 en Chile— y tres se cayeron a la vez.
 *
 * Es la misma familia que esta noche se estuvo sacando del repositorio: una
 * prueba que mide la hora de la máquina en vez de lo que dice medir. Y la
 * escribí yo hace dos horas.
 *
 * 15:00 en Chile, en una fecha cualquiera: fuera del silencio por defecto y
 * lejos de los bordes.
 */
const DE_DIA_EN_CHILE = new Date('2026-03-10T18:00:00Z');

const probar = (telefono: string, deps: Record<string, unknown> = {}) =>
  probarEnvio(
    { pool: admin, redis: null, ahora: DE_DIA_EN_CHILE, ...deps } as Parameters<typeof probarEnvio>[0],
    { tenantId: tenant, accountId, telefono },
  );

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  tenant = (
    await admin.query("INSERT INTO tenants (name, plan, state) VALUES ('prueba-587', 'base', 'active') RETURNING id")
  ).rows[0].id;
  const conectado = await withTenant(admin, tenant, (c) =>
    connectWhatsAppNumber(c, {
      tenantId: tenant,
      name: 'WhatsApp del negocio',
      senderId: 'snd_587',
      phoneNumberId: 'pn_587',
      displayPhone: '+56911110000',
      credentialRef: 'ZAVU_API_KEY',
      webhookSecretRef: 'ZAVU_WEBHOOK_SECRET',
    }),
  );
  accountId = conectado.account.id;
});

afterAll(async () => {
  for (const tabla of ['messages', 'conversations', 'contacts', 'whatsapp_numbers', 'channel_accounts', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.end();
});

/**
 * Un número que ESCRIBIÓ, hace `horas` horas **contadas desde el reloj fijo**.
 *
 * Lo segundo es el punto. `receiveInbound` deja `last_inbound_at = now()`, o sea
 * el reloj de la máquina, y las pruebas preguntan con `DE_DIA_EN_CHILE`. Mezclar
 * las dos cosas hace que la ventana de 24 h se mida entre dos relojes distintos:
 * con el reloj fijo en marzo y el dato en octubre, el último mensaje queda en el
 * FUTURO y la ventana sale abierta por la razón equivocada.
 *
 * Con las dos puntas ancladas al mismo instante, la prueba no depende del día ni
 * de la hora en que se corra.
 */
async function queEscribio(phone: string, horas = 1): Promise<void> {
  await withTenant(admin, tenant, (c) =>
    receiveInbound(c, {
      tenantId: tenant,
      phone,
      channel: 'whatsapp',
      channelAccountId: accountId,
      body: 'hola',
      providerMessageId: `in-${phone}`,
    }),
  );
  await admin.query(
    `UPDATE conversations
        SET last_inbound_at = $3::timestamptz - make_interval(hours => $4)
      WHERE tenant_id = $1
        AND contact_id = (SELECT id FROM contacts WHERE tenant_id = $1 AND phone = $2)`,
    [tenant, phone, DE_DIA_EN_CHILE.toISOString(), horas],
  );
}

describe('cuando la prueba SÍ sale (#587)', () => {
  it('va por el camino real, al número pedido, con el texto que explica qué es', async () => {
    await queEscribio('+56922220001');
    const falso = despachoFalso({ providerMessageId: 'msg_del_proveedor' });
    const r = await probar('+56922220001', { despachar: falso.despachar });

    expect(r.ok).toBe(true);
    expect(r.motivo).toBeNull();
    expect(r.providerMessageId).toBe('msg_del_proveedor');
    // El texto NO lo elige quien prueba: quien lo recibe tiene que entender por
    // qué le llegó, y «test» desde el número de un negocio es peor que no probar.
    expect(falso.llamadas).toEqual([{ to: '+56922220001', body: CUERPO_DE_PRUEBA }]);
  });
});

describe('cada camino dice lo suyo (#587)', () => {
  it('un número que nunca escribió: ventana cerrada, y lo explica', async () => {
    // Es el diagnóstico más probable de todos, y antes se veía igual que
    // «falta el emisor».
    const falso = despachoFalso({ providerMessageId: 'no-deberia' });
    const r = await probar('+56999990000', { despachar: falso.despachar });
    expect(r.motivo).toBe('VENTANA_CERRADA');
    expect(r.mensaje).toMatch(/nunca te escribió/i);
    // Y NO se intentó mandar: la regla se aplica antes de tocar al proveedor.
    expect(falso.llamadas).toEqual([]);
  });

  it('un contacto que pidió no recibir: sin consentimiento, y tampoco se intenta', async () => {
    await queEscribio('+56922220002');
    await admin.query(
      "UPDATE contacts SET opted_out_at = now() WHERE tenant_id = $1 AND phone = $2",
      [tenant, '+56922220002'],
    );
    const falso = despachoFalso({ providerMessageId: 'no-deberia' });
    const r = await probar('+56922220002', { despachar: falso.despachar });
    expect(r.motivo).toBe('SIN_CONSENTIMIENTO');
    expect(falso.llamadas).toEqual([]);
  });

  it('escribió hace más de 24 h: ventana cerrada, no «sin consentimiento»', async () => {
    // La distinción importa: una se arregla pidiéndole que escriba, la otra no
    // se arregla — hay que respetar que pidió no recibir.
    await queEscribio('+56922220003', 30);
    const r = await probar('+56922220003', { despachar: despachoFalso({ providerMessageId: 'x' }).despachar });
    expect(r.motivo).toBe('VENTANA_CERRADA');
    expect(r.mensaje).toMatch(/24 horas/i);
  });

  it('el canal desconectado: lo dice antes de mirar nada más', async () => {
    await admin.query("UPDATE channel_accounts SET state = 'disconnected' WHERE id = $1", [accountId]);
    const r = await probar('+56922220001');
    expect(r.motivo).toBe('CANAL_NO_ACTIVO');
    expect(r.mensaje).toMatch(/disconnected/);
    await admin.query("UPDATE channel_accounts SET state = 'active' WHERE id = $1", [accountId]);
  });

  it('el tenant en solo lectura: no sale lo iniciado por el negocio', async () => {
    await admin.query("UPDATE tenants SET state = 'read_only' WHERE id = $1", [tenant]);
    const r = await probar('+56922220001');
    expect(r.motivo).toBe('TENANT_SIN_ENVIO');
    await admin.query("UPDATE tenants SET state = 'active' WHERE id = $1", [tenant]);
  });

  it('la calidad en rojo pausó los envíos del negocio: lo dice con el motivo guardado', async () => {
    await admin.query(
      `UPDATE whatsapp_numbers SET business_paused_at = now(), paused_reason = 'Calidad en rojo: Meta castigó el número.'
        WHERE tenant_id = $1 AND channel_account_id = $2`,
      [tenant, accountId],
    );
    const r = await probar('+56922220001');
    expect(r.motivo).toBe('CALIDAD_PAUSADA');
    expect(r.mensaje).toMatch(/calidad en rojo/i);
    await admin.query(
      `UPDATE whatsapp_numbers SET business_paused_at = NULL, paused_reason = NULL
        WHERE tenant_id = $1 AND channel_account_id = $2`,
      [tenant, accountId],
    );
  });

  it('en horario de silencio se RECHAZA, no se difiere', async () => {
    // Diferir una prueba es dejar a alguien esperando un resultado que llega a
    // las ocho de la mañana. Lo que se difiere es un mensaje del negocio; una
    // prueba se contesta ahora, aunque la respuesta sea «no, estás en silencio».
    // Con el reloj, no tocando la configuración del tenant: el silencio por
    // defecto es 21:00–08:00, así que basta con preguntar a las 23:00 de Chile.
    // Mover los ajustes y devolverlos dejaba una ventana donde otra prueba del
    // mismo archivo podía leerlos cambiados.
    const DE_NOCHE_EN_CHILE = new Date('2026-03-11T02:00:00Z');
    const falso = despachoFalso({ providerMessageId: 'no-deberia' });
    const r = await probar('+56922220001', {
      despachar: falso.despachar,
      ahora: DE_NOCHE_EN_CHILE,
    });
    expect(r.motivo).toBe('HORARIO_DE_SILENCIO');
    expect(r.mensaje).toMatch(/no se difiere/i);
    expect(falso.llamadas).toEqual([]);
  });
});

describe('lo que contesta el proveedor (#587)', () => {
  it('un rechazo PERMANENTE trae el detalle crudo, que es lo que falta para arreglarlo', async () => {
    const permanente = Object.assign(
      new Error('Este canal no tiene emisor asignado. Revisa su conexión.'),
      { permanente: true, detalle: '{"error":"sender_not_found","senderId":"snd_587"}' },
    );
    const r = await probar('+56922220001', { despachar: despachoFalso(permanente).despachar });
    expect(r.motivo).toBe('CANAL_RECHAZO');
    expect(r.mensaje).toMatch(/emisor/i);
    // El cuerpo del proveedor: es la contraparte de #556 — acá sí, en la
    // bandeja no. Sin esto, «revisa su conexión» manda a adivinar qué revisar.
    expect(r.detalle).toContain('sender_not_found');
  });

  it('un fallo INTERMITENTE se nombra distinto: no manda a revisar lo que está bien', async () => {
    const r = await probar('+56922220001', {
      despachar: despachoFalso(new Error('503 Service Unavailable')).despachar,
    });
    expect(r.motivo).toBe('PROVEEDOR_INTERMITENTE');
    expect(r.mensaje).toMatch(/temporal/i);
    expect(r.detalle).toContain('503');
  });
});

describe('WhatsApp solo llega a celulares (#582)', () => {
  it('un fijo chileno se rechaza diciendo ESO, no «teléfono inválido»', async () => {
    // La distinción es el punto: `+56229123456` es un teléfono perfectamente
    // válido. Decirle «inválido» manda a corregir un número que está bien
    // escrito, y quien prueba se queda buscando el error donde no está.
    const falso = despachoFalso({ providerMessageId: 'no-deberia' });
    const r = await probar('+56229123456', { despachar: falso.despachar });
    expect(r.motivo).toBe('NO_ES_MOVIL');
    expect(r.mensaje).toMatch(/solo llega a celulares/i);
    expect(r.mensaje).toMatch(/está bien escrito/i);
    expect(falso.llamadas).toEqual([]);
  });

  it('un número de fuera de Chile NO se bloquea: el tipo no se puede saber', async () => {
    // `tipoDeLinea` devuelve `no_se` fuera de Chile, y `no_se` pasa. Bloquear
    // por una duda es bloquear a un cliente de verdad; lo que sigue decidiendo
    // acá es la ventana de 24 h, no una suposición sobre el tipo de línea.
    const falso = despachoFalso({ providerMessageId: 'no-deberia' });
    const r = await probar('+14085551234', { despachar: falso.despachar });
    expect(r.motivo).not.toBe('NO_ES_MOVIL');
  });
});
