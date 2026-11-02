#!/usr/bin/env node
/**
 * El pulso del evento, desde afuera (#1210).
 *
 * Para copiar a cualquier VPS y correr ahí: lo único que necesita es Node y
 * `pg`. No importa nada del monorepo a propósito —en una VPS no hay repo
 * compilado— y por eso NO decide ni manda: el criterio y el envío viven en
 * `packages/modules/agents/application/pulso.ts` y en el proceso de agents,
 * que es lo que corre con el horario de silencio, el consentimiento y el
 * sello que hace contable cada pulso.
 *
 * Lo que sí hace, y es lo que no se puede hacer desde el panel:
 *
 *   --estado          muestra, conversación por conversación, qué va a pasar
 *                     y por qué. No toca nada. Es el modo por defecto.
 *   --prender         prende el pulso del agente con sus parámetros.
 *   --apagar          lo apaga. Un toque, desde el teléfono, en medio del
 *                     evento, sin esperar un despliegue.
 *
 * Uso:
 *
 *   npm i pg
 *   DATABASE_URL='postgres://…' node pulso-del-evento.mjs
 *   DATABASE_URL='postgres://…' node pulso-del-evento.mjs --prender \
 *     --desde 08:30 --hasta 18:00 --cada 40 --tope 6
 *   DATABASE_URL='postgres://…' node pulso-del-evento.mjs --apagar
 *
 * Con varios negocios en la base, `--tenant <uuid>`. Con uno solo lo toma.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let Pool;
try {
  ({ Pool } = require('pg'));
} catch {
  console.error('Falta `pg`. En la VPS: npm i pg');
  process.exit(1);
}

const args = process.argv.slice(2);
const bandera = (n) => args.includes(`--${n}`);
const valor = (n, def) => {
  const i = args.indexOf(`--${n}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Falta DATABASE_URL. Es la misma del contenedor de la API.');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 2, connectionTimeoutMillis: 20_000 });

/** El reloj de la BASE y no el de la VPS: una VPS en otra zona mentiría. */
async function ahoraEnLaBase(c) {
  // Como TEXTO ya formateado por Postgres: devolverlo como fecha hace que
  // Node le vuelva a aplicar la zona de la VPS y muestre una hora que no es
  // ni la de Chile ni la del servidor.
  const r = await c.query(
    `SELECT to_char(now() AT TIME ZONE 'America/Santiago', 'DD/MM/YYYY HH24:MI') AS local`,
  );
  return { local: r.rows[0].local };
}

async function elNegocio(c) {
  const pedido = valor('tenant');
  if (pedido) return pedido;
  // Los que TIENEN agente activo, y veinte como máximo: la base de desarrollo
  // acumula miles de negocios de prueba y listarlos todos vuelve ilegible el
  // único renglón que importa.
  const r = await c.query(
    `SELECT t.id, t.name, count(a.id) AS agentes
       FROM tenants t
       LEFT JOIN agents a ON a.tenant_id = t.id AND a.active = true
      WHERE COALESCE(t.state,'active') <> 'deleted'
      GROUP BY t.id, t.name
     HAVING count(a.id) > 0
      ORDER BY max(a.updated_at) DESC NULLS LAST`,
  );
  if (r.rowCount === 1) return r.rows[0].id;
  if (r.rowCount === 0) {
    console.error('Ningún negocio de esta base tiene un agente activo.');
    process.exit(1);
  }
  console.error(`Hay ${r.rowCount} negocios con agente activo. Elige uno con --tenant:`);
  for (const t of r.rows.slice(0, 20)) console.error(`  ${t.id}  ${t.name}`);
  if (r.rowCount > 20) console.error(`  … y ${r.rowCount - 20} más (los de arriba son los de agente más reciente)`);
  process.exit(1);
}

async function elAgente(c, tenantId) {
  const r = await c.query(
    `SELECT id, name, limits, active, default_mode FROM agents
      WHERE tenant_id = $1 AND active = true ORDER BY created_at`,
    [tenantId],
  );
  if (!r.rowCount) {
    console.error('Este negocio no tiene ningún agente activo.');
    process.exit(1);
  }
  const conPulso = r.rows.find((a) => a.limits?.pulso?.activo === true);
  return conPulso ?? r.rows[0];
}

function pintarConfig(agente) {
  const p = agente.limits?.pulso;
  if (!p || p.activo !== true) return 'APAGADO';
  return `PRENDIDO · cada ${p.cada_minutos ?? 40} min · ${p.desde ?? '—'} a ${p.hasta ?? '—'} · tope ${p.max_por_persona ?? 6} por persona`;
}

async function estado(c, tenantId, agente) {
  const { local } = await ahoraEnLaBase(c);
  console.log(`Negocio   ${tenantId}`);
  console.log(`Agente    ${agente.name} (${agente.default_mode})`);
  console.log(`Pulso     ${pintarConfig(agente)}`);
  console.log(`Ahora     ${local} (hora de Chile, del reloj de la base)`);

  const p = agente.limits?.pulso ?? {};
  const cada = Number(p.cada_minutos) > 0 ? Number(p.cada_minutos) : 40;
  const tope = Number(p.max_por_persona) > 0 ? Number(p.max_por_persona) : 6;

  /**
   * Un espejo de `tocaPulso`, en SQL, para MIRAR. No es la autoridad: si
   * alguna vez difiere de `pulso.ts`, el que manda es `pulso.ts` y esto es lo
   * que está mal. Está acá porque en una VPS no hay módulo compilado que
   * importar, y ver por qué alguien no recibió nada vale el espejo.
   */
  const r = await c.query(
    `SELECT k.phone, k.name,
            c2.last_inbound_at,
            (SELECT max(m.created_at) FROM messages m
              WHERE m.tenant_id = c2.tenant_id AND m.conversation_id = c2.id AND m.direction='out') AS saliente,
            (SELECT count(*) FROM messages m
              WHERE m.tenant_id = c2.tenant_id AND m.conversation_id = c2.id
                AND m.direction='out' AND m.meta->>'pulso' = '1') AS pulsos,
            (SELECT mode FROM agent_conversation_modes am
              WHERE am.tenant_id = c2.tenant_id AND am.conversation_id = c2.id) AS marca,
            now() - c2.last_inbound_at > interval '24 hours' AS ventana_cerrada,
            to_char(now() AT TIME ZONE 'America/Santiago', 'HH24:MI') AS hhmm
       FROM conversations c2
       JOIN contacts k ON k.id = c2.contact_id
      WHERE c2.tenant_id = $1 AND c2.state IN ('new','open') AND c2.archived_at IS NULL
        AND k.opted_out_at IS NULL AND c2.last_inbound_at IS NOT NULL
      ORDER BY c2.last_inbound_at DESC
      LIMIT 200`,
    [tenantId],
  );

  const minutos = (d) => (d ? Math.round((Date.now() - new Date(d).getTime()) / 60_000) : null);
  const cuenta = {};
  const filas = r.rows.map((f) => {
    const desdeSaliente = minutos(f.saliente ?? f.last_inbound_at);
    let motivo = 'MANDA';
    if (agente.limits?.pulso?.activo !== true) motivo = 'apagado';
    else if (f.ventana_cerrada) motivo = 'ventana_cerrada';
    else if (p.desde && p.hasta && !(f.hhmm >= p.desde && f.hhmm < p.hasta)) motivo = 'fuera_de_horario';
    else if (Number(f.pulsos) >= tope) motivo = 'tope_alcanzado';
    else if (desdeSaliente < cada) motivo = `muy_pronto (faltan ${cada - desdeSaliente} min)`;
    else if (f.marca === 'off') motivo = 'conversacion_en_off';
    cuenta[motivo.split(' ')[0]] = (cuenta[motivo.split(' ')[0]] ?? 0) + 1;
    return { tel: f.phone ?? '—', quien: f.name ?? '', pulsos: Number(f.pulsos), hace: desdeSaliente, motivo };
  });

  console.log(`\n${filas.length} conversaciones abiertas:\n`);
  for (const f of filas) {
    console.log(
      `  ${String(f.tel).padEnd(14)} ${String(f.quien).slice(0, 16).padEnd(17)} ` +
        `pulsos ${String(f.pulsos).padStart(2)}  último mensaje hace ${String(f.hace).padStart(4)} min  →  ${f.motivo}`,
    );
  }
  console.log('\nResumen: ' + Object.entries(cuenta).map(([m, n]) => `${m} ${n}`).join(' · '));
  if (agente.limits?.pulso?.activo !== true) {
    console.log('\nEl pulso está APAGADO: nada de esto va a pasar hasta que lo prendas.');
  }
}

async function prender(c, tenantId, agente) {
  const pulso = {
    activo: true,
    cada_minutos: Number(valor('cada', 40)),
    desde: valor('desde', '08:30'),
    hasta: valor('hasta', '18:00'),
    max_por_persona: Number(valor('tope', 6)),
  };
  if (!/^\d{2}:\d{2}$/.test(pulso.desde) || !/^\d{2}:\d{2}$/.test(pulso.hasta)) {
    console.error('El horario va como HH:MM, p. ej. --desde 08:30 --hasta 18:00');
    process.exit(1);
  }
  await c.query(
    `UPDATE agents SET limits = COALESCE(limits,'{}'::jsonb) || $3::jsonb, updated_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, agente.id, JSON.stringify({ pulso })],
  );
  console.log(`Pulso PRENDIDO en «${agente.name}»: cada ${pulso.cada_minutos} min, de ${pulso.desde} a ${pulso.hasta}, tope ${pulso.max_por_persona} por persona.`);
  console.log('El primer pulso sale cuando a alguien le toque; con --estado ves a quién.');
}

async function apagar(c, tenantId, agente) {
  await c.query(
    `UPDATE agents SET limits = jsonb_set(COALESCE(limits,'{}'::jsonb), '{pulso,activo}', 'false'::jsonb), updated_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, agente.id],
  );
  console.log(`Pulso APAGADO en «${agente.name}». Los parámetros quedan guardados para volver a prenderlo.`);
}

const c = await pool.connect();
try {
  const tenantId = await elNegocio(c);
  const agente = await elAgente(c, tenantId);
  if (bandera('prender')) await prender(c, tenantId, agente);
  else if (bandera('apagar')) await apagar(c, tenantId, agente);
  else await estado(c, tenantId, agente);
} finally {
  c.release();
  await pool.end();
}
