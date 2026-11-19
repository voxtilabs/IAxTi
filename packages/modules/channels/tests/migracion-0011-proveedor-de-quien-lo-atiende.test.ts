import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createPool } from '@iaxti/db';

/**
 * La migración 0011 (#1339): cada fila queda con el nombre de QUIÉN la
 * atiende de verdad.
 *
 * Se corre contra una base efímera con el SQL real, como
 * `migracion-emisor.test.ts`: la base compartida de la suite ya tiene la
 * migración aplicada y no puede probar el tránsito.
 *
 * Las dos verdades que la migración arregla, cada una con su herramienta:
 *  · webchat/simulador NUNCA fueron de Zavu — la etiqueta venía del DEFAULT
 *    de la 0006 y se repunta al proveedor que sí los atiende;
 *  · las cuentas de WhatsApp que pasaron por Zavu NO se repuntan — su
 *    etiqueta es historia y resuelve a «nadie», que para lo desconectado es
 *    lo correcto. Lo que la etiqueta histórica no puede hacer es tumbar el
 *    arranque: `proveedores_de_cuentas()` pasa a contar solo lo que puede
 *    mandar.
 */
const nombre = `iaxti_mig0011_${randomUUID().replaceAll('-', '')}`;
const url = new URL(process.env.DATABASE_URL!);
const adminUrl = new URL(url);
adminUrl.pathname = '/postgres';
const admin = createPool(adminUrl.toString());
url.pathname = `/${nombre}`;
const db = createPool(url.toString());

const sql = (archivo: string) =>
  readFileSync(resolve(__dirname, '../migrations', archivo), 'utf8');

beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${nombre}"`);
  await db.query('CREATE TABLE tenants(id uuid PRIMARY KEY)');
  await db.query(sql('0001_channels.sql'));
  await db.query(sql('0006_el_proveedor_es_de_la_cuenta.sql'));
  const negocio = randomUUID();
  await db.query('INSERT INTO tenants(id) VALUES ($1)', [negocio]);
  // Las filas de la época: webchat y simulador sin declarar (el DEFAULT de
  // la 0006 los etiquetó 'zavu'), y dos cuentas de WhatsApp que SÍ pasaron
  // por Zavu — una viva y una desconectada, que es como quedó el corte de la
  // épica #1338.
  await db.query(
    `INSERT INTO channel_accounts(tenant_id,kind,name,state,credential_ref,webhook_secret_ref,config)
     VALUES ($1,'webchat','Chat del sitio','active','TEST_KEY','TEST_HOOK','{}'),
            ($1,'simulador','Simulador','active','TEST_KEY','TEST_HOOK','{}'),
            ($1,'whatsapp','WhatsApp de Zavu','active','TEST_KEY','TEST_HOOK','{"senderId":"snd-vivo"}'),
            ($1,'whatsapp','WhatsApp de Zavu archivado','disconnected','TEST_KEY','TEST_HOOK','{"senderId":"snd-muerto"}')`,
    [negocio],
  );
});

afterAll(async () => {
  await db.end();
  await admin.query(`DROP DATABASE "${nombre}" WITH (FORCE)`);
  await admin.end();
});

it('webchat y simulador quedan con su proveedor real; las de Zavu conservan su historia', async () => {
  await db.query(sql('0011_proveedor_de_quien_lo_atiende.sql'));

  const filas = (await db.query('SELECT kind, provider, state FROM channel_accounts ORDER BY kind, state')).rows;
  expect(filas).toEqual([
    // Repuntadas: su proveedor es el adaptador que de verdad las atiende.
    { kind: 'simulador', provider: 'simulador', state: 'active' },
    { kind: 'webchat', provider: 'webchat', state: 'active' },
    // Las de Zavu NO se tocan: mentirles un proveedor que nunca las atendió
    // sería peor que el dato viejo.
    { kind: 'whatsapp', provider: 'zavu', state: 'active' },
    { kind: 'whatsapp', provider: 'zavu', state: 'disconnected' },
  ]);
});

it('la verificación del arranque cuenta solo lo que puede mandar', async () => {
  await db.query(sql('0011_proveedor_de_quien_lo_atiende.sql'));

  const lista = async () =>
    (await db.query('SELECT proveedores_de_cuentas() AS p')).rows.map((r: { p: string }) => r.p);

  // La cuenta VIVA de Zavu sigue declarando a un proveedor sin adaptador:
  // eso es exactamente el fallo de arranque que la guarda existe para
  // impedir — nadie registra a Zavu desde #1339, y una cuenta viva no puede
  // caer en silencio al que esté. Ordenada: la función declara ORDER BY 1.
  expect(await lista()).toEqual(['simulador', 'webchat', 'zavu']);

  // El canal ARCHIVADO también declara 'zavu', y la lista no lo distingue
  // (DISTINCT): la prueba directa del filtro de estado es desaparecer la
  // única cuenta viva de Zavu y ver que 'zavu' se va de la lista. Con la
  // función de la 0006 —que contaba TODAS las filas— 'zavu' se quedaba: una
  // base con historia de Zavu era imposible de levantar el día que su
  // adaptador dejó de registrarse.
  await db.query("UPDATE channel_accounts SET state = 'disconnected' WHERE state = 'active' AND kind = 'whatsapp'");
  expect(await lista()).toEqual(['simulador', 'webchat']);
});
