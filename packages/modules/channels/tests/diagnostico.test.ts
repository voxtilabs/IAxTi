import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createChannelAccount, setChannelState } from '../application/accounts';
import { anotarWebhook, rastroDeWebhook } from '../application/rastro';
import { diagnosticarCanal } from '../application/diagnostico';
import { resetProviders } from '../domain/port';

/**
 * Por qué no llegan los mensajes (#434).
 *
 * Lo que se prueba es la distinción que costó horas dos veces esta semana:
 * «nunca llegó un webhook» y «llegan pero la firma no calza» se veían
 * idénticos desde adentro —la bandeja vacía— y se arreglan en lugares
 * distintos: uno es la URL configurada en el proveedor, el otro el secreto.
 */
const URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
let pool: Pool;
let tenant: string;
const en = <T>(fn: (c: PoolClient) => Promise<T>) => withTenant(pool, tenant, fn);

beforeAll(async () => {
  pool = createPool(URL);
  await runMigrations(pool);
  const t = await pool.query("INSERT INTO tenants (name) VALUES ('diagnostico') RETURNING id");
  tenant = t.rows[0].id;
});

afterAll(async () => {
  await pool.query('DELETE FROM channel_accounts WHERE tenant_id = $1', [tenant]);
  await pool.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  await pool.end();
  resetProviders();
});

/** Una cuenta ya conectada: `connecting` es un estado aparte y se prueba abajo. */
async function cuentaNueva(nombre: string) {
  const cuenta = await en((c) =>
    createChannelAccount(c, {
      tenantId: tenant,
      kind: 'whatsapp',
      name: nombre,
      credentialRef: 'LLAVE_DE_PRUEBA',
      webhookSecretRef: 'SECRETO_DE_PRUEBA',
      // Con emisor: este ayudante arma un canal SANO, y sin `senderId` no
      // sale ni un mensaje (#526). Sin esto las pruebas del webhook estarían
      // corriendo sobre una cuenta que en producción no podría contestar.
      config: { senderId: 'sender-de-prueba' },
    }),
  );
  await en((c) => setChannelState(c, { tenantId: tenant, accountId: cuenta.id, state: 'active' }));
  return cuenta;
}

const SIEMPRE = { hayCredencial: () => true };

describe('el rastro del webhook', () => {
  it('sin webhooks, no hay rastro', async () => {
    const cuenta = await cuentaNueva('sin rastro');
    const r = await en((c) => rastroDeWebhook(c, tenant, cuenta.id));
    expect(r.ultimo).toBeNull();
    expect(r.resultado).toBeNull();
  });

  it('guarda cuándo y cómo, y conserva aparte el último bueno', async () => {
    const cuenta = await cuentaNueva('con rastro');
    await en((c) => anotarWebhook(c, { tenantId: tenant, accountId: cuenta.id, resultado: 'aceptado' }));
    const bueno = await en((c) => rastroDeWebhook(c, tenant, cuenta.id));
    expect(bueno.resultado).toBe('aceptado');
    expect(bueno.ultimoBueno).not.toBeNull();

    // Empieza a fallar: sigue sirviendo saber DESDE CUÁNDO.
    await en((c) =>
      anotarWebhook(c, { tenantId: tenant, accountId: cuenta.id, resultado: 'firma_invalida' }),
    );
    const malo = await en((c) => rastroDeWebhook(c, tenant, cuenta.id));
    expect(malo.resultado).toBe('firma_invalida');
    expect(malo.ultimoBueno?.getTime()).toBe(bueno.ultimoBueno?.getTime());
  });

  it('no escribe la fila en cada webhook, pero SÍ cuando el resultado cambia', async () => {
    // Un negocio activo recibe miles al día y todos caen en la misma fila:
    // escribirla en cada uno la vuelve un punto caliente. Pero el primero
    // que falla después de una racha buena es justo el que hay que ver.
    const cuenta = await cuentaNueva('sin punto caliente');
    await en((c) => anotarWebhook(c, { tenantId: tenant, accountId: cuenta.id, resultado: 'aceptado' }));
    const primero = await en((c) => rastroDeWebhook(c, tenant, cuenta.id));

    await new Promise((r) => setTimeout(r, 20));
    await en((c) => anotarWebhook(c, { tenantId: tenant, accountId: cuenta.id, resultado: 'aceptado' }));
    const repetido = await en((c) => rastroDeWebhook(c, tenant, cuenta.id));
    expect(repetido.ultimo?.getTime()).toBe(primero.ultimo?.getTime()); // no se reescribió

    await en((c) =>
      anotarWebhook(c, { tenantId: tenant, accountId: cuenta.id, resultado: 'firma_invalida' }),
    );
    const cambio = await en((c) => rastroDeWebhook(c, tenant, cuenta.id));
    expect(cambio.ultimo!.getTime()).toBeGreaterThan(primero.ultimo!.getTime());
  });
});

describe('el diagnóstico', () => {
  it('«nunca llegó un webhook» manda a revisar la URL, no el secreto', async () => {
    const cuenta = await cuentaNueva('sin webhooks');
    const d = await en((c) =>
      diagnosticarCanal(c, { tenantId: tenant, accountId: cuenta.id }, SIEMPRE),
    );
    expect(d.problema).toBe('webhook');
    const paso = d.pasos.find((p) => p.id === 'webhook')!;
    expect(paso.detalle).toContain('Nunca');
    expect(paso.queHacer).toContain('URL');
    expect(paso.queHacer).toContain('emisor'); // el error de esta semana
  });

  it('«la firma no calza» manda al secreto DEL EMISOR, no al del proyecto', async () => {
    const cuenta = await cuentaNueva('firma mala');
    await en((c) =>
      anotarWebhook(c, { tenantId: tenant, accountId: cuenta.id, resultado: 'firma_invalida' }),
    );
    const d = await en((c) =>
      diagnosticarCanal(c, { tenantId: tenant, accountId: cuenta.id }, SIEMPRE),
    );
    expect(d.problema).toBe('webhook');
    const paso = d.pasos.find((p) => p.id === 'webhook')!;
    expect(paso.detalle).toContain('no calzó');
    expect(paso.detalle).toContain('Nunca se aceptó');
    expect(paso.queHacer).toMatch(/DEL EMISOR/);
  });

  it('la credencial dice el NOMBRE de la variable y nunca el valor', async () => {
    const cuenta = await cuentaNueva('sin llave');
    const d = await en((c) =>
      diagnosticarCanal(c, { tenantId: tenant, accountId: cuenta.id }, { hayCredencial: () => false }),
    );
    const paso = d.pasos.find((p) => p.id === 'credencial')!;
    expect(paso.estado).toBe('mal');
    expect(paso.detalle).toContain('LLAVE_DE_PRUEBA');
    expect(paso.queHacer).toContain('LLAVE_DE_PRUEBA');
  });

  it('el primer problema manda: no se muestran seis cuando hay uno', async () => {
    // Si el webhook nunca llegó, que falte la plantilla es irrelevante — y
    // seis problemas a la vez hacen que no se arregle ninguno.
    const cuenta = await cuentaNueva('todo mal');
    const d = await en((c) =>
      diagnosticarCanal(
        c,
        { tenantId: tenant, accountId: cuenta.id },
        { hayCredencial: () => false, plantillasAprobadas: async () => 0 },
      ),
    );
    expect(d.problema).toBe('credencial'); // el primero en orden, no el último
  });

  it('que nadie haya escrito NO es un problema', async () => {
    // Un remedio para el silencio manda a arreglar lo que funciona.
    const cuenta = await cuentaNueva('en silencio');
    await en((c) => anotarWebhook(c, { tenantId: tenant, accountId: cuenta.id, resultado: 'aceptado' }));
    const d = await en((c) =>
      diagnosticarCanal(
        c,
        { tenantId: tenant, accountId: cuenta.id },
        { ...SIEMPRE, entrantesRecientes: async () => 0 },
      ),
    );
    const paso = d.pasos.find((p) => p.id === 'mensajes')!;
    expect(paso.estado).not.toBe('mal');
    expect(paso.queHacer).toBeUndefined();
    expect(d.problema).toBeNull();
  });

  it('una cuenta desconectada se dice como tal', async () => {
    const cuenta = await cuentaNueva('desconectada');
    await en((c) => setChannelState(c, { tenantId: tenant, accountId: cuenta.id, state: 'disconnected' }));
    const d = await en((c) =>
      diagnosticarCanal(c, { tenantId: tenant, accountId: cuenta.id }, SIEMPRE),
    );
    expect(d.problema).toBe('cuenta');
  });

  it('sin plantillas aprobadas avisa, pero no rompe: se puede responder dentro de 24 h', async () => {
    const cuenta = await cuentaNueva('sin plantillas');
    await en((c) => anotarWebhook(c, { tenantId: tenant, accountId: cuenta.id, resultado: 'aceptado' }));
    const d = await en((c) =>
      diagnosticarCanal(
        c,
        { tenantId: tenant, accountId: cuenta.id },
        { ...SIEMPRE, plantillasAprobadas: async () => 0 },
      ),
    );
    expect(d.pasos.find((p) => p.id === 'plantillas')!.estado).toBe('atencion');
    expect(d.problema).toBeNull();
  });

  it('una conexión a medias avisa, pero no tapa el problema de abajo', async () => {
    // `connecting` no es un fallo: la cuenta igual recibe webhooks. Si se
    // tratara como error, el diagnóstico diría "termina de conectarlo"
    // cuando el problema real es que el webhook apunta a otra parte.
    const cuenta = await en((c) =>
      createChannelAccount(c, {
        tenantId: tenant,
        kind: 'whatsapp',
        name: 'a medio conectar',
        credentialRef: 'LLAVE_DE_PRUEBA',
        webhookSecretRef: 'SECRETO_DE_PRUEBA',
      }),
    );
    const d = await en((c) =>
      diagnosticarCanal(c, { tenantId: tenant, accountId: cuenta.id }, SIEMPRE),
    );
    expect(d.pasos.find((p) => p.id === 'cuenta')!.estado).toBe('atencion');
    expect(d.problema).toBe('webhook');
  });
});

describe('el canal que recibe y no manda (#526)', () => {
  it('sin emisor, lo dice: los mensajes llegan y no sale ninguno', async () => {
    // El caso que el diagnóstico no veía. El adaptador lee `config.senderId` y
    // sin él lanza en CADA envío, mientras los entrantes siguen llegando
    // —se resuelven por el id de la cuenta del webhook—. Todo salía verde y el
    // negocio veía los mensajes de sus clientes sin poder contestar ninguno.
    const cuenta = await en((c) =>
      createChannelAccount(c, {
        tenantId: tenant,
        kind: 'whatsapp',
        name: 'Sin emisor',
        credentialRef: 'LLAVE_DE_PRUEBA',
        webhookSecretRef: 'SECRETO_DE_PRUEBA',
      }),
    );
    await en((c) => setChannelState(c, { tenantId: tenant, accountId: cuenta.id, state: 'active' }));
    await en((c) =>
      anotarWebhook(c, {
        tenantId: tenant,
        accountId: cuenta.id,
        resultado: 'aceptado',
      }),
    );

    const d = await en((c) =>
      diagnosticarCanal(
        c,
        { tenantId: tenant, accountId: cuenta.id },
        { hayCredencial: () => true },
      ),
    );
    const emisor = d.pasos.find((p) => p.id === 'emisor');
    expect(emisor?.estado).toBe('mal');
    expect(emisor?.detalle).toContain('no sale ninguno');
    // Y con el webhook llegando bien, el emisor ES el problema: es lo que
    // convierte «no sé qué pasa» en una cosa que arreglar.
    expect(d.problema).toBe('emisor');
  });

  it('el webhook manda sobre el emisor: sin webhook, el consejo es la URL', async () => {
    // El orden va de afuera hacia adentro. Si el webhook nunca llegó no hay
    // conversación que contestar, y mandar a revisar el emisor sería el
    // consejo equivocado.
    const cuenta = await en((c) =>
      createChannelAccount(c, {
        tenantId: tenant,
        kind: 'whatsapp',
        name: 'Ni webhook ni emisor',
        credentialRef: 'LLAVE_DE_PRUEBA',
        webhookSecretRef: 'SECRETO_DE_PRUEBA',
      }),
    );
    await en((c) => setChannelState(c, { tenantId: tenant, accountId: cuenta.id, state: 'active' }));
    const d = await en((c) =>
      diagnosticarCanal(
        c,
        { tenantId: tenant, accountId: cuenta.id },
        { hayCredencial: () => true },
      ),
    );
    expect(d.problema).toBe('webhook');
  });

  it('el webchat no necesita emisor y no se marca en rojo', async () => {
    // Entrega DENTRO de la app. Marcarlo mal sería mandar a arreglar algo que
    // no existe, y el diagnóstico perdería el sentido de mostrar un problema.
    const cuenta = await en((c) =>
      createChannelAccount(c, { tenantId: tenant, kind: 'webchat', name: 'Chat del sitio' }),
    );
    await en((c) => setChannelState(c, { tenantId: tenant, accountId: cuenta.id, state: 'active' }));
    const d = await en((c) =>
      diagnosticarCanal(
        c,
        { tenantId: tenant, accountId: cuenta.id },
        { hayCredencial: () => true },
      ),
    );
    expect(d.pasos.find((p) => p.id === 'emisor')?.estado).toBe('bien');
  });
});
