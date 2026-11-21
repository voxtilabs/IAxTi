#!/usr/bin/env node
/**
 * Preparar un tenant que YA existe para una demo (#1219).
 *
 * Dos cosas, y las dos se piden aparte:
 *
 *   --limpiar   borra los contactos SINTÉTICOS (los de las pruebas).
 *   --sembrar   llama a `sembrarDemo` (#432): contactos con nombre, empresas,
 *               un embudo con oportunidades en varias etapas, conversaciones y
 *               citas. Por las funciones del producto y idempotente.
 *
 * Sin banderas solo MIRA y no toca nada, igual que la vista previa obligatoria
 * de las campañas (#75): el conteo y la muestra salen de la misma consulta que
 * después elige a quién borrar.
 *
 *   node scripts/preparar-la-demo.mjs --tenant <uuid>
 *   node scripts/preparar-la-demo.mjs --tenant <uuid> --limpiar --sembrar
 *
 * ## Por qué el borrado va por SQL, y con qué cuidados
 *
 * El producto NO sabe borrar un contacto: el contrato de `crm` tiene
 * `archiveCompany`, `deleteTag`, `deleteStage` y nada para contactos. El único
 * borrado sancionado es la retención (SPEC §39), que borra por antigüedad y no
 * por teléfono. Así que esto es un script de operación, no código de módulo, y
 * carga con tres cuidados:
 *
 *  1. **Patrón de teléfono explícito**, nunca «todos». Solo los sintéticos.
 *  2. **Vista previa por defecto.** Borrar es lo que hay que pedir, no lo que
 *     pasa por omisión.
 *  3. **Jamás en producción.** `IAXTI_ENV=production` lo rechaza.
 *
 * Y el motivo del cuidado no es formal: el número de staging es el real de
 * VoxTi y gente real le escribió. Un borrado «de todos» se lleva esas
 * conversaciones y no se recuperan.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * Los teléfonos que son de prueba y de nadie.
 *
 * `+569 0000 xxxx` y `+569 1111 xxxx` los inventaron las pruebas del repo y las
 * mías; no son números que un cliente pueda tener.
 *
 * `+569 9900 xxxx` NO está en esta lista, y la primera versión lo tenía. Son
 * los contactos que SIEMBRA `sembrarDemo` —Camila Fuentes, Matías Rojas…
 * (`PERSONAS` en demo.ts)—, o sea justo los que la demo necesita. Correr
 * `--limpiar --sembrar` los habría borrado y vuelto a crear en el mismo
 * comando, y con otro orden habría dejado el CRM vacío. Lo encontró la
 * corrida de vista previa contra la base local, no la lectura del patrón.
 */
const SINTETICOS = ['+5690000%', '+5691111%'];

const args = process.argv.slice(2);
const bandera = (n) => args.includes(`--${n}`);
const valor = (n, def) => {
  const i = args.indexOf(`--${n}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};

if ((process.env.IAXTI_ENV ?? '') === 'production') {
  console.error('Esto no corre en producción. Es un preparador de demos.');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('Falta DATABASE_URL.');
  process.exit(1);
}

const { createPool, withTenant } = require('@iaxti/db');
const pool = createPool();

async function elTenant() {
  const pedido = valor('tenant');
  if (pedido) return pedido;
  const r = await pool.query(
    `SELECT id, name FROM tenants WHERE COALESCE(state,'active') <> 'deleted' ORDER BY created_at`,
  );
  if (r.rowCount === 1) return r.rows[0].id;
  console.error(`Hay ${r.rowCount} negocios. Elige uno con --tenant:`);
  for (const t of r.rows.slice(0, 20)) console.error(`  ${t.id}  ${t.name}`);
  process.exit(1);
}

/** Lo que hay hoy, separando lo sintético de lo que escribió gente de verdad. */
async function mirar(tenantId) {
  const condicion = SINTETICOS.map((_, i) => `k.phone LIKE $${i + 2}`).join(' OR ');
  const r = await withTenant(pool, tenantId, (c) =>
    c.query(
      `SELECT k.id, k.name, k.phone,
              (${condicion}) AS sintetico,
              (SELECT count(*) FROM conversations v WHERE v.contact_id = k.id) AS conversaciones,
              (SELECT count(*) FROM deals d WHERE d.contact_id = k.id) AS oportunidades
         FROM contacts k
        WHERE k.tenant_id = $1
        ORDER BY (${condicion}) DESC, k.created_at`,
      [tenantId, ...SINTETICOS],
    ),
  );
  const sinteticos = r.rows.filter((f) => f.sintetico);
  const reales = r.rows.filter((f) => !f.sintetico);
  console.log(
    `\nContactos: ${r.rowCount} — ${sinteticos.length} de prueba (se borran con --limpiar), ` +
      `${reales.length} que se conservan.\n`,
  );
  for (const f of sinteticos.slice(0, 8)) {
    console.log(`  [prueba] ${String(f.phone).padEnd(15)} ${String(f.name ?? '').slice(0, 22).padEnd(23)} ${f.conversaciones} conv · ${f.oportunidades} oport`);
  }
  if (sinteticos.length > 8) console.log(`  … y ${sinteticos.length - 8} más de prueba`);
  console.log('');
  for (const f of reales.slice(0, 10)) {
    console.log(`  [queda]  ${String(f.phone).padEnd(15)} ${String(f.name ?? '').slice(0, 22).padEnd(23)} ${f.conversaciones} conv · ${f.oportunidades} oport`);
  }
  if (reales.length > 10) console.log(`  … y ${reales.length - 10} más que se conservan`);
  return { sinteticos, reales };
}

async function limpiar(tenantId, sinteticos) {
  if (!sinteticos.length) {
    console.log('\nNo hay contactos de prueba que borrar.');
    return;
  }
  const ids = sinteticos.map((f) => f.id);
  // En una transacción y por id, no por el patrón otra vez: la lista que se
  // borra es EXACTAMENTE la que se mostró arriba. Repetir el LIKE abriría la
  // puerta a que entre algo que la vista previa no mostró.
  const borrados = await withTenant(pool, tenantId, async (c) => {
    const m = await c.query(
      `DELETE FROM messages WHERE tenant_id = $1 AND conversation_id IN
         (SELECT id FROM conversations WHERE tenant_id = $1 AND contact_id = ANY($2::uuid[]))`,
      [tenantId, ids],
    );
    const v = await c.query(
      `DELETE FROM conversations WHERE tenant_id = $1 AND contact_id = ANY($2::uuid[])`,
      [tenantId, ids],
    );
    const d = await c.query(`DELETE FROM deals WHERE tenant_id = $1 AND contact_id = ANY($2::uuid[])`, [tenantId, ids]);
    const k = await c.query(`DELETE FROM contacts WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [tenantId, ids]);
    return { mensajes: m.rowCount, conversaciones: v.rowCount, oportunidades: d.rowCount, contactos: k.rowCount };
  });
  console.log(`\nBorrado lo de prueba: ${borrados.contactos} contactos, ${borrados.conversaciones} conversaciones, ${borrados.mensajes} mensajes, ${borrados.oportunidades} oportunidades.`);
  console.log('Los contactos de personas reales quedaron intactos.');
}

async function sembrar(tenantId) {
  const { sembrarDemo } = require('@iaxti/seed/dist/demo.js');
  // Los dos usuarios del negocio: las conversaciones y las citas se reparten
  // entre ellos. Una bandeja donde todo es de nadie no se parece a ninguna.
  const u = await pool.query(
    `SELECT user_id FROM memberships WHERE tenant_id = $1 ORDER BY created_at LIMIT 2`,
    [tenantId],
  );
  if (!u.rowCount) {
    console.error('Este negocio no tiene usuarios: sin dueños no se puede repartir nada.');
    process.exit(1);
  }
  const duenaId = u.rows[0].user_id;
  const vendedorId = u.rows[1]?.user_id ?? duenaId;
  const r = await sembrarDemo(pool, { tenantId, duenaId, vendedorId });
  if (r.yaEstaba) console.log('\nLos datos de demostración ya estaban: el seed no duplica nada.');
  else console.log('\nSembrado: contactos, empresas, embudo con oportunidades, conversaciones y citas.');
  if (r.chatUrl) console.log(`Chat web de la demo: ${r.chatUrl}`);
}

const tenantId = await elTenant();
console.log(`Negocio ${tenantId}`);
const { sinteticos } = await mirar(tenantId);
if (!bandera('limpiar') && !bandera('sembrar')) {
  console.log('\n(Vista previa: no se tocó nada. Agrega --limpiar y/o --sembrar.)');
} else {
  if (bandera('limpiar')) await limpiar(tenantId, sinteticos);
  if (bandera('sembrar')) await sembrar(tenantId);
}
await pool.end();
