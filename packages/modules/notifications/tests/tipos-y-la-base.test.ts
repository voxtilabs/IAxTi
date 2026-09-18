import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { NOTIFICATION_TYPES, TIPOS_LEGIBLES, notifyUser } from '../application/notifications';
import { EVENTOS as EVENTOS_CONSUMIDOS } from '../application/consumers';

/**
 * Los tipos de aviso del código contra el CHECK de la base (issue 273).
 *
 * `pago_recibido` se agregó en TypeScript —con su texto y su consumidor— y
 * nadie tocó el CHECK. El cliente pagaba, el consumidor armaba el aviso y el
 * INSERT explotaba; como el consumidor del outbox lanza, el evento se
 * reintentaba para siempre.
 *
 * El compilador no ve la base y la base no ve el tipo. Este test es el que
 * los mira a los dos.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('tipos-aviso') RETURNING id");
  tenant = t.rows[0].id;
});

afterAll(async () => {
  await admin.end();
});

describe('los tipos que el código conoce y los que la base acepta', () => {
  it('son los mismos', async () => {
    const r = await admin.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'notifications'::regclass AND conname = 'notifications_type_check'`,
    );
    const def = r.rows[0]?.def as string | undefined;
    expect(def, 'no existe el CHECK de tipos en notifications').toBeDefined();

    const enLaBase = [...(def ?? '').matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]).sort();
    expect(enLaBase).toEqual([...NOTIFICATION_TYPES].sort());
  });

  it('cada tipo del código se puede escribir de verdad', async () => {
    // El test de arriba compara textos; este los mete en la tabla. Si el
    // CHECK dijera lo correcto y algo más fallara —una columna NOT NULL sin
    // valor, por ejemplo—, la comparación de textos no lo vería.
    for (const tipo of NOTIFICATION_TYPES) {
      const usuario = randomUUID();
      await withTenant(admin, tenant, (c) =>
        notifyUser(c, {
          tenantId: tenant,
          userId: usuario,
          type: tipo,
          title: TIPOS_LEGIBLES[tipo],
        }),
      );
      const fila = await admin.query(
        'SELECT type FROM notifications WHERE tenant_id = $1 AND user_id = $2',
        [tenant, usuario],
      );
      expect(fila.rows[0]?.type, `el tipo "${tipo}" no se pudo escribir`).toBe(tipo);
    }
  });

  it('cada tipo tiene texto legible: un aviso sin título no se puede mostrar', () => {
    for (const tipo of NOTIFICATION_TYPES) {
      expect(TIPOS_LEGIBLES[tipo], `falta el texto de "${tipo}"`).toBeTruthy();
    }
  });
});

describe('los eventos que se consumen y los que el manifiesto declara', () => {
  it('son los mismos', () => {
    const yaml = readFileSync(join(__dirname, '../module.yaml'), 'utf8');
    const bloque = yaml.split('consumes:')[1]?.split(/^\w/m)[0] ?? '';
    const declarados = [...bloque.matchAll(/^\s+- ([\w.]+)$/gm)].map((m) => m[1]).sort();

    // `payment.received` tenía su `case`, estaba en EVENTOS y NO estaba en el
    // manifiesto. El catálogo de eventos sale de los manifiestos: un evento
    // sin declarar es un consumidor que nadie sabe que existe — no aparece en
    // la documentación, ni en los webhooks salientes, ni en el test de
    // combinación.
    expect(declarados).toEqual([...EVENTOS_CONSUMIDOS].sort());
  });
});
