import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createTenant } from '@iaxti/module-organizations';
import { enviarElEnlace } from '../application/enviar-el-enlace';
import type { PartnerPorts } from '../application/partner-provider';

/**
 * El enlace del alta, por correo (#1259).
 *
 * Lo que se prueba es el CERCO, no el envío: quién puede recibirlo, en qué
 * fases se manda y qué queda escrito. El cerco es lo único que vuelve
 * aceptable sacar un secreto de la custodia cifrada y dejarlo en una bandeja
 * de entrada.
 */
const URL_BASE = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
let pool: Pool;

async function negocio(): Promise<string> {
  pool ??= createPool(URL_BASE);
  await runMigrations(pool);
  const t = await withTenant(pool, randomUUID(), (c) => createTenant(c, { name: 'Barbería Dos Sillas' }));
  return t.id;
}

/** Unos `ports` que solo saben contestar el estado: es lo único que se mira. */
const portsCon = (estado: Record<string, unknown>) =>
  ({ config: {}, enabled: () => true, secrets: {}, call: async () => ({}) }) as unknown as PartnerPorts;

async function conEstado(estado: Record<string, unknown>, fn: () => Promise<unknown>) {
  const mod = await import('../application/partner-invitations');
  const espia = vi.spyOn(mod, 'partnerStatus').mockResolvedValue(estado as never);
  try {
    return await fn();
  } finally {
    espia.mockRestore();
  }
}

describe('mandar el enlace por correo (#1259)', () => {
  const pendiente = { id: randomUUID(), phase: 'pending', url: 'https://dashboard.zavu.dev/invite/abc123' };

  it('con la invitación pendiente, manda el enlace y lo audita', async () => {
    const t = await negocio();
    const mandados: Array<{ para: string; enlace: string }> = [];
    const r = (await conEstado(pendiente, () =>
      enviarElEnlace(
        pool,
        { tenantId: t, actor: randomUUID(), actorKind: 'user', correoDelActor: 'duena@negocio.cl', nombreDelNegocio: 'Barbería Dos Sillas' },
        portsCon(pendiente),
        async (c) => { mandados.push({ para: c.para, enlace: c.enlace }); return true; },
      ),
    )) as { enviado: boolean; para: string };

    expect(r).toEqual({ enviado: true, para: 'duena@negocio.cl' });
    expect(mandados).toEqual([{ para: 'duena@negocio.cl', enlace: pendiente.url }]);

    const a = await pool.query(
      `SELECT action, result, metadata FROM audit_log WHERE tenant_id=$1 AND action='whatsapp.invitation.link_emailed'`,
      [t],
    );
    expect(a.rowCount).toBe(1);
    expect(a.rows[0].metadata).toMatchObject({ para: 'duena@negocio.cl' });
    // El destinatario sí, el ENLACE no: la auditoría es lo que se lee cuando
    // algo salió mal, y un secreto ahí es un secreto filtrado.
    expect(JSON.stringify(a.rows[0].metadata)).not.toContain('abc123');
  });

  it('a otra dirección cuando se la escriben', async () => {
    const t = await negocio();
    let destino = '';
    await conEstado(pendiente, () =>
      enviarElEnlace(
        pool,
        { tenantId: t, actor: randomUUID(), actorKind: 'user', para: 'elquetiene@elfono.cl', correoDelActor: 'duena@negocio.cl', nombreDelNegocio: 'X' },
        portsCon(pendiente),
        async (c) => { destino = c.para; return true; },
      ),
    );
    expect(destino).toBe('elquetiene@elfono.cl');
  });

  /**
   * `active` y `expired` no son «casi pending». Reenviar sobre una conexión
   * activa invita a conectar otro número; mandar un enlace vencido deja a
   * quien lo recibe creyendo que hizo algo mal.
   */
  it.each([
    ['active', 'ya tiene su WhatsApp conectado'],
    ['expired', 'No hay una conexión pendiente'],
    ['none', 'No hay una conexión pendiente'],
  ])('no manda nada con la invitación en %s', async (phase, mensaje) => {
    const t = await negocio();
    const espia = vi.fn();
    await expect(
      conEstado({ id: null, phase, url: null }, () =>
        enviarElEnlace(
          pool,
          { tenantId: t, actor: randomUUID(), actorKind: 'user', correoDelActor: 'duena@negocio.cl', nombreDelNegocio: 'X' },
          portsCon({}),
          espia,
        ),
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining(mensaje) });
    expect(espia).not.toHaveBeenCalled();
  });

  /** Una dirección mal escrita se rechaza ANTES de consultar nada. */
  it.each(['sin-arroba', 'con espacio@x.cl', 'nada@', '@nada.cl', ''])(
    'rechaza la dirección %j sin llegar al proveedor',
    async (correo) => {
      const t = await negocio();
      const espia = vi.fn();
      await expect(
        enviarElEnlace(
          pool,
          { tenantId: t, actor: randomUUID(), actorKind: 'user', para: correo, correoDelActor: null, nombreDelNegocio: 'X' },
          portsCon({}),
          espia,
        ),
      ).rejects.toMatchObject({ code: 'CORREO_INVALIDO' });
      expect(espia).not.toHaveBeenCalled();
    },
  );
});
