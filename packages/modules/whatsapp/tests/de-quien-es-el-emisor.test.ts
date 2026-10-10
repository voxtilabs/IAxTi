import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { connectWhatsAppNumber, desconectarNumero, tenantDelEmisor } from '../application/numbers';

/**
 * De quién es un emisor del proveedor (#771).
 *
 * Todos los tenants comparten una llave de proyecto de Zavu, así que ese
 * proyecto contiene los emisores de TODOS los negocios. La ruta que los lista y
 * la que los acepta para reapuntar (#600) no tenían forma de saber de quién es
 * cada uno: `elegirSender` solo mira si el emisor tiene el canal encendido.
 *
 * Lo medido antes de este arreglo: el tenant A veía «snd_xxx · Ferretería El
 * Sol», y podía apuntar su canal a un emisor que otro negocio no había conectado
 * todavía —o que había archivado— y quedar despachando WhatsApp **desde el
 * número de un tercero**.
 *
 * El aislamiento lo sostenía, por accidente, el único global de `sender_id`:
 * chocaba SOLO con un emisor activo en otro tenant, y sin que nadie atrapara el
 * 23505.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenantA: string;
let tenantB: string;

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  // Un plan propio y no tocar 'base': el cupo de números es 1 ahí, y subirlo
  // cambiaría lo que ven otras suites que corren sobre la misma base.
  await admin.query(
    `INSERT INTO plan_limits (plan, whatsapp_numbers, conversations_month, ia_executions_month,
                              retention_months, api_requests_month, modules)
     VALUES ('emisores771', 5, 1000, 100, 12, 10000, '[]'::jsonb)
     ON CONFLICT (plan) DO UPDATE SET whatsapp_numbers = 5`,
  );
  const crear = async (nombre: string) =>
    (
      await admin.query(
        "INSERT INTO tenants (name, plan) VALUES ($1, 'emisores771') RETURNING id",
        [nombre],
      )
    ).rows[0].id;
  tenantA = await crear('emisores-A-771');
  tenantB = await crear('emisores-B-771');
});

afterAll(async () => {
  for (const t of [tenantA, tenantB]) {
    for (const tabla of ['whatsapp_numbers', 'channel_accounts', 'outbox']) {
      await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [t]);
    }
  }
  await admin.end();
});

const conectar = (tenant: string, senderId: string, phoneNumberId: string) =>
  withTenant(admin, tenant, (c) =>
    connectWhatsAppNumber(c, {
      tenantId: tenant,
      name: 'WhatsApp',
      senderId,
      phoneNumberId,
      credentialRef: 'ZAVU_API_KEY',
      webhookSecretRef: 'ZAVU_WEBHOOK_SECRET',
    }),
  );

describe('tenant_del_emisor (#771)', () => {
  it('un emisor que nadie conectó es de NADIE: así se puede tomar en un onboarding', async () => {
    expect(await tenantDelEmisor(admin, 'snd_libre')).toBeNull();
  });

  it('un emisor conectado es de SU tenant, y se ve desde fuera de su contexto', async () => {
    // Lo segundo es el punto: `whatsapp_numbers` tiene RLS, así que desde el
    // contexto del tenant A la fila de B no se ve — y no verla es exactamente lo
    // que producía el agujero. Por eso va por una función SECURITY DEFINER.
    await conectar(tenantB, 'snd_de_b', 'pn_de_b');
    expect(await tenantDelEmisor(admin, 'snd_de_b')).toBe(tenantB);
    // Y preguntando DENTRO del contexto de A, que es como lo hace la ruta:
    const desdeA = await withTenant(admin, tenantA, (c) => tenantDelEmisor(c, 'snd_de_b'));
    expect(desdeA, 'A no puede ver que ese emisor ya tiene dueño').toBe(tenantB);
  });

  it('un emisor ARCHIVADO sigue siendo de su tenant', async () => {
    // El hueco más fino: el único parcial de la migración 0007 deja de proteger
    // al archivado, así que sin esto A podía tomar el número que B dio de baja.
    // Un número que un negocio archivó sigue siendo su número.
    const { account } = await conectar(tenantB, 'snd_archivado_de_b', 'pn_arch_b');
    await withTenant(admin, tenantB, (c) =>
      desconectarNumero(c, { tenantId: tenantB, accountId: account.id }),
    );
    expect(await tenantDelEmisor(admin, 'snd_archivado_de_b')).toBe(tenantB);
  });

  it('devuelve SOLO el tenant: nada del negocio se filtra con la respuesta', async () => {
    // Es la regla de ADR-0026. Una función que cruza tenants devuelve lo mínimo
    // para decidir, porque cualquier cosa de más es la misma fuga por otra
    // puerta: el nombre del emisor ES el nombre del negocio.
    const r = await admin.query("SELECT tenant_del_emisor('snd_de_b') AS tenant");
    expect(Object.keys(r.rows[0])).toEqual(['tenant']);
  });

  it('con el mismo emisor archivado y vivo, gana el VIVO', async () => {
    // Desconectar y reconectar el mismo sender deja dos filas (lo habilita 0007).
    // El dueño es el mismo, pero el orden importa para no contestar con la fila
    // muerta cuando las dos existen.
    const { account } = await conectar(tenantA, 'snd_de_a_dos_veces', 'pn_a_1');
    await withTenant(admin, tenantA, (c) =>
      desconectarNumero(c, { tenantId: tenantA, accountId: account.id }),
    );
    await conectar(tenantA, 'snd_de_a_dos_veces', 'pn_a_2');
    expect(await tenantDelEmisor(admin, 'snd_de_a_dos_veces')).toBe(tenantA);
  });
});
