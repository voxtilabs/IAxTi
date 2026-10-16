import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPool, runMigrations, withTenant, sinTriggers } from '@iaxti/db';
import { conectarSender, consultarSender, quienSoy, type SenderZavu } from '../application/conectar';
import { createZavuProvider } from '../application/zavu';
import { reapuntarEmisor, tenantDelEmisor } from '../application/numbers';
import { cuentaDelEmisor, emisorAcreditado, getChannelAccount, setChannelState } from '@iaxti/module-channels';

const admin = createPool(process.env.DATABASE_URL);
const tenants: string[] = [];
async function tenant() { const r = await admin.query("INSERT INTO tenants(name) VALUES ('Meta ficticio 74') RETURNING id"); tenants.push(r.rows[0].id); return r.rows[0].id as string; }
beforeAll(() => runMigrations(admin));
afterAll(async () => {
  await sinTriggers(admin, async (c) => {
    for (const t of ['channel_senders', 'whatsapp_numbers', 'channel_accounts', 'audit_log', 'outbox']) await c.query(`DELETE FROM ${t} WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [tenants]);
  }); await admin.end();
});

describe('conexión por canal y contrato Zavu (#74)', () => {
  it.each(['instagram', 'messenger'] as const)('prepara %s sin número, sin rotación ni activación prematura', async (kind) => {
    const t = await tenant(); const llamar = vi.fn().mockResolvedValue({});
    const sender: SenderZavu = { id: randomUUID(), name: 'Cuenta ficticia', channels: [kind] };
    const r = await withTenant(admin, t, (c) => conectarSender(c, { tenantId: t, nombre: sender.name, sender, kind,
      baseUrl: 'https://api.example.test', credentialRef: 'TEST_74_KEY', webhookSecretRef: 'TEST_74_HOOK', llamar }));
    expect(r.number).toBeNull(); expect(r.account.kind).toBe(kind); expect(r.account.state).toBe('connecting');
    expect(r.webhookSecret).toBeNull();
    expect(llamar).toHaveBeenCalledExactlyOnceWith(`/senders/${sender.id}`, expect.objectContaining({ method: 'PATCH' }));
    expect((await admin.query('SELECT * FROM whatsapp_numbers WHERE tenant_id=$1', [t])).rows).toHaveLength(0);
  });
  it('una segunda cuenta reutiliza webhook y refs de WhatsApp sin PATCH ni regeneración', async () => {
    const t = await tenant(); const sender: SenderZavu = { id: randomUUID(), name: 'Multicanal', channels: ['whatsapp', 'instagram'] };
    const base = { tenantId: t, nombre: sender.name, sender, baseUrl: 'https://api.example.test', credentialRef: 'TEST_74_KEY', webhookSecretRef: 'TEST_74_HOOK' };
    const wa = await withTenant(admin, t, (c) => conectarSender(c, { ...base, llamar: vi.fn().mockResolvedValue({ secret: 'ficticio' }) }));
    const llamar = vi.fn();
    const ig = await withTenant(admin, t, (c) => conectarSender(c, { ...base, kind: 'instagram', llamar }));
    expect(ig.webhookUrl).toBe(wa.webhookUrl); expect(llamar).not.toHaveBeenCalled();
    expect(ig.account.credentialRef).toBe(wa.account.credentialRef);
    await withTenant(admin, t, (c) => setChannelState(c, { tenantId: t, accountId: ig.account.id, state: 'active' }));
    const nuevo = randomUUID();
    await expect(withTenant(admin, t, (c) => reapuntarEmisor(c, { tenantId: t, accountId: wa.account.id, senderId: nuevo }))).rejects.toThrow('comparte su webhook');
    expect((await withTenant(admin, t, (c) => getChannelAccount(c, t, wa.account.id))).config.senderId).toBe(sender.id);
    expect((await admin.query('SELECT sender_id FROM whatsapp_numbers WHERE tenant_id=$1', [t])).rows[0].sender_id).toBe(sender.id);
    expect(await tenantDelEmisor(admin, nuevo)).toBeNull();
    expect((await withTenant(admin, t, (c) => cuentaDelEmisor(c, { tenantId: t, senderId: sender.id, webhookAccountId: wa.account.id, kind: 'instagram' })))?.id).toBe(ig.account.id);
  });
  it('al reapuntar una cuenta sola conserva propiedad antigua sin ofrecerla como receptor de nuevas conexiones', async () => {
    const t = await tenant(); const sender: SenderZavu = { id: randomUUID(), name: 'Única', channels: ['whatsapp', 'instagram'] };
    const base = { tenantId: t, nombre: sender.name, sender, baseUrl: 'https://api.example.test', credentialRef: 'TEST_74_KEY', webhookSecretRef: 'TEST_74_HOOK' };
    const wa = await withTenant(admin, t, (c) => conectarSender(c, { ...base, llamar: vi.fn().mockResolvedValue({ secret: 'ficticio' }) }));
    const nuevo = randomUUID();
    await withTenant(admin, t, (c) => reapuntarEmisor(c, { tenantId: t, accountId: wa.account.id, senderId: nuevo }));
    expect(await tenantDelEmisor(admin, sender.id)).toBe(t); expect(await tenantDelEmisor(admin, nuevo)).toBe(t);
    expect(await withTenant(admin, t, (c) => emisorAcreditado(c, t, sender.id))).toBeNull();
    expect((await withTenant(admin, t, (c) => emisorAcreditado(c, t, nuevo)))?.id).toBe(wa.account.id);
    const llamar = vi.fn();
    await expect(withTenant(admin, t, (c) => conectarSender(c, { ...base, kind: 'instagram', llamar }))).rejects.toThrow('receptor de este emisor cambió');
    expect(llamar).not.toHaveBeenCalled();
    expect((await admin.query('SELECT count(*)::int AS n FROM channel_accounts WHERE tenant_id=$1', [t])).rows[0].n).toBe(1);
  });
  it('no infiere canal por teléfono y valida capacidad antes de cualquier escritura', async () => {
    const t = await tenant(); const llamar = vi.fn();
    await expect(withTenant(admin, t, (c) => conectarSender(c, { tenantId: t, nombre: 'No sirve', kind: 'instagram',
      sender: { id: randomUUID(), name: 'Ficticio', phoneNumber: '+56900000000', channels: ['whatsapp'] },
      baseUrl: 'https://api.example.test', credentialRef: 'TEST_74_KEY', webhookSecretRef: 'TEST_74_HOOK', llamar }))).rejects.toThrow('no tiene el canal instagram');
    expect(llamar).not.toHaveBeenCalled();
    expect((await admin.query('SELECT * FROM channel_accounts WHERE tenant_id=$1', [t])).rows).toHaveLength(0);
  });
  it('lee GET plano, valida identidad/capacidades y descarta cualquier secreto del DTO', async () => {
    const llamar = vi.fn().mockResolvedValue({ id: 'snd/74', name: 'Ficticio', channels: ['instagram'], webhook: { secret: 'no-debe-salir', url: 'https://api.example.test/hook', active: true } });
    const r = await consultarSender(llamar, 'snd/74');
    expect(llamar).toHaveBeenCalledWith('/senders/snd%2F74'); expect(JSON.stringify(r)).not.toContain('no-debe-salir');
    await expect(consultarSender(vi.fn().mockResolvedValue({ id: 'otro', name: 'X', channels: [] }), 'snd/74')).rejects.toThrow('inválida');
    await expect(consultarSender(vi.fn().mockResolvedValue({ id: 'snd/74', name: 'X', channels: [42] }), 'snd/74')).rejects.toThrow('inválida');
  });
  it('no decide el ambiente usando una respuesta incompleta del proveedor', async () => {
    await expect(quienSoy(vi.fn().mockResolvedValue({ project: { id: 'ficticio', name: 'Prueba' } }))).rejects.toThrow('modo de la credencial');
    await expect(quienSoy(vi.fn().mockResolvedValue({ isTestMode: false }))).rejects.toThrow('proyecto');
  });
  it.each(['instagram', 'messenger'] as const)('%s conserva destino/canal en texto y no hace POST para adjuntos/plantillas', async (kind) => {
    process.env.TEST_74_ADAPTER = 'ficticio';
    try {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message: { id: 'msg-74' } }) });
      const p = createZavuProvider(kind, { fetchImpl });
      const account = { id: randomUUID(), tenantId: randomUUID(), name: 'Ficticia', kind, state: 'active' as const, credentialRef: 'TEST_74_ADAPTER', config: { senderId: 'sender-74' } };
      await p.send(account, { to: '17841400000000000', type: 'texto', body: 'Hola', messageId: 'propio-74' });
      expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({ to: '17841400000000000', channel: kind, text: 'Hola', fallbackEnabled: false, idempotencyKey: 'propio-74' });
      fetchImpl.mockClear();
      await expect(p.send(account, { to: '17841400000000000', type: 'imagen', attachments: [{ url: 'https://example.test/photo.png', contentType: 'image/png' }] })).rejects.toThrow('solo permite enviar texto');
      await expect(p.send(account, { to: '17841400000000000', type: 'texto', extra: { plantilla: {} } })).rejects.toThrow('solo permite enviar texto');
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally { delete process.env.TEST_74_ADAPTER; }
  });
});
