import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, runMigrations, withTenant, sinTriggers } from '@iaxti/db';
import { createChannelAccount, setChannelState } from '../application/accounts';
import { reservarEmisor, emisorAcreditado, cuentaDelEmisor, tenantDelEmisorDeCanal } from '../application/senders';

const admin = createPool(process.env.DATABASE_URL);
// Turbo/CI solo transmite DATABASE_URL; nunca sustituir el rol RLS por owner.
const appUrl = new URL(process.env.DATABASE_URL!);
appUrl.username = 'iaxti_channels74'; appUrl.password = 'iaxti_channels74';
const app = createPool(appUrl.toString());
const tenants: string[] = [];
async function tenant() {
  const r = await admin.query("INSERT INTO tenants(name) VALUES ('Emisor ficticio 74') RETURNING id");
  tenants.push(r.rows[0].id); return r.rows[0].id as string;
}
async function alta(t: string, sender: string, kind: 'whatsapp' | 'instagram' | 'messenger' = 'instagram', fallar = false, hook = 'TEST_74_HOOK') {
  return withTenant(app, t, async (c) => {
    const cuenta = await createChannelAccount(c, { tenantId: t, kind, name: 'Ficticia', credentialRef: 'TEST_74_KEY', webhookSecretRef: hook, config: { senderId: sender } });
    const reserva = await reservarEmisor(c, { tenantId: t, senderId: sender, accountId: cuenta.id, actor: 'operador-ficticio', actorKind: 'user' });
    await setChannelState(c, { tenantId: t, accountId: cuenta.id, state: 'active' });
    if (fallar) throw new Error('Falla posterior deliberada');
    return { cuenta, reserva };
  });
}
beforeAll(async () => {
  await runMigrations(admin);
  await admin.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='iaxti_channels74') THEN CREATE ROLE iaxti_channels74 LOGIN PASSWORD 'iaxti_channels74'; END IF; END $$");
  expect((await admin.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname='iaxti_channels74'")).rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  await admin.query('GRANT USAGE ON SCHEMA public TO iaxti_channels74');
  await admin.query('GRANT SELECT, INSERT, UPDATE, DELETE ON channel_accounts, channel_senders TO iaxti_channels74');
  await admin.query('GRANT SELECT, INSERT ON audit_log TO iaxti_channels74');
  await admin.query('GRANT INSERT ON outbox TO iaxti_channels74');
  await admin.query('GRANT EXECUTE ON FUNCTION tenant_de_emisor_de_canal(text) TO iaxti_channels74');
});
afterAll(async () => {
  await app.end();
  await sinTriggers(admin, async (c) => {
    for (const table of ['channel_senders', 'channel_accounts', 'audit_log', 'outbox']) await c.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [tenants]);
  });
  await admin.end();
});

describe('reserva de emisor compartido (#74)', () => {
  it('RLS no devuelve la reserva ni sus referencias al otro tenant', async () => {
    const [a, b] = await Promise.all([tenant(), tenant()]); const sender = randomUUID();
    const { cuenta } = await alta(a, sender);
    expect(await withTenant(app, b, (c) => emisorAcreditado(c, b, sender))).toBeNull();
    expect(await withTenant(app, b, (c) => c.query('SELECT * FROM channel_senders WHERE sender_id=$1', [sender])).then((r) => r.rowCount)).toBe(0);
    expect(await tenantDelEmisorDeCanal(app, sender)).toBe(a);
    // La FK compuesta protege también escrituras directas con un UUID conocido.
    await expect(withTenant(app, b, (c) => c.query(
      'INSERT INTO channel_senders(sender_id, tenant_id, webhook_account_id) VALUES ($1,$2,$3)',
      [randomUUID(), b, cuenta.id],
    ))).rejects.toThrow(/foreign key/);
  });
  it('dos tenants compiten: solo uno obtiene cuenta, reserva, evento y auditoría', async () => {
    const [a, b] = await Promise.all([tenant(), tenant()]); const sender = randomUUID();
    const resultados = await Promise.allSettled([alta(a, sender), alta(b, sender)]);
    expect(resultados.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const ganador = resultados[0].status === 'fulfilled' ? a : b;
    const perdedor = ganador === a ? b : a;
    for (const table of ['channel_accounts', 'channel_senders', 'audit_log', 'outbox']) {
      expect((await admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id=$1`, [perdedor])).rows[0].n).toBe(0);
    }
    expect((await admin.query('SELECT actor, actor_kind FROM audit_log WHERE tenant_id=$1', [ganador])).rows).toEqual([{ actor: 'operador-ficticio', actor_kind: 'user' }]);
  });
  it('un receptor DESCONECTADO no impone sus referencias: la conexión nueva lo reemplaza (#1190)', async () => {
    /**
     * El caso real, medido en staging el 02-11. Un canal de WhatsApp quedó
     * `disconnected` con `webhook_secret_ref=ZAVU_WEBHOOK_SECRET`, y el flujo de
     * invitación crea el suyo con `ZAVU_PARTNER_PENDING` —su marcador de
     * «todavía no custodié el secreto»—. La comparación de referencias lanzaba
     * SIEMPRE, así que un número que alguna vez se conectó a mano no se podía
     * reconectar por invitación nunca. Y el `catch` del barrido lo mostraba
     * como `PARTNER_PROVIDER_FAILED`, culpando al proveedor.
     */
    const t = await tenant();
    const sender = `snd_${randomUUID().replaceAll('-', '')}`;
    const vieja = await alta(t, sender, 'whatsapp');
    await withTenant(app, t, (c) => setChannelState(c, { tenantId: t, accountId: vieja.cuenta.id, state: 'disconnected' }));

    // Con OTRA referencia de secreto, que es lo que hacía imposible el caso.
    const nueva = await alta(t, sender, 'whatsapp', false, 'PENDIENTE_DE_CUSTODIA');
    expect(nueva.reserva.webhookAccountId).toBe(nueva.cuenta.id);
    expect(nueva.reserva.primeraConexion).toBe(true);
    // La reserva quedó apuntando al canal nuevo, no al desconectado.
    expect((await withTenant(app, t, (c) => emisorAcreditado(c, t, sender)))?.id).toBe(nueva.cuenta.id);
    // Y el traspaso queda en la auditoría: quién recibe los webhooks de un
    // emisor no es un detalle que pueda cambiar sin rastro.
    const rastro = await admin.query(
      "SELECT metadata FROM audit_log WHERE tenant_id = $1 AND action = 'channel.sender.rebound'",
      [t],
    );
    expect(rastro.rows).toHaveLength(1);
    expect(rastro.rows[0].metadata.receptorAnterior).toBe(vieja.cuenta.id);
  });

  it('un receptor VIVO sigue imponiendo sus referencias (#1190)', async () => {
    // La otra mitad, y la que no se puede aflojar: un emisor tiene UN receptor
    // de webhooks y UN secreto. Dos canales vivos con secretos distintos
    // partirían la entrada, y el fallo se vería como mensajes que no llegan.
    const t = await tenant();
    const sender = `snd_${randomUUID().replaceAll('-', '')}`;
    await alta(t, sender, 'whatsapp');
    await expect(alta(t, sender, 'instagram', false, 'OTRO_HOOK')).rejects.toThrow(
      /referencias de su conexión original/i,
    );
  });

  it('el segundo canal conserva receptor primario y se resuelve por canal dentro del tenant', async () => {
    const t = await tenant(); const sender = randomUUID();
    const wa = await alta(t, sender, 'whatsapp'); const ig = await alta(t, sender);
    expect(ig.reserva).toEqual({ webhookAccountId: wa.cuenta.id, primeraConexion: false });
    const destino = await withTenant(app, t, (c) => cuentaDelEmisor(c, { tenantId: t, senderId: sender, webhookAccountId: wa.cuenta.id, kind: 'instagram' }));
    expect(destino?.id).toBe(ig.cuenta.id);
    expect(await withTenant(app, t, (c) => cuentaDelEmisor(c, { tenantId: t, senderId: randomUUID(), webhookAccountId: wa.cuenta.id, kind: 'instagram' }))).toBeNull();
  });
  it('la carrera del mismo canal no crea dos destinos y un fallo posterior revierte también audit', async () => {
    const t = await tenant(); const sender = randomUUID();
    const r = await Promise.allSettled([alta(t, sender), alta(t, sender)]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const otro = await tenant();
    await expect(alta(otro, randomUUID(), 'messenger', true)).rejects.toThrow('Falla posterior');
    for (const table of ['channel_accounts', 'channel_senders', 'audit_log', 'outbox']) {
      expect((await admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id=$1`, [otro])).rows[0].n).toBe(0);
    }
  });
});
