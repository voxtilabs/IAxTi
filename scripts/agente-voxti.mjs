#!/usr/bin/env node
/**
 * Deja el agente de VoxTi Labs vendiendo, y lo saca del evento.
 *
 * El agente se armó para el Tech AI Summit del 3 de noviembre y siguió
 * invitando a un stand que ya no existe. Su configuración vivía SOLO en la
 * base de staging, así que para cambiarla había que entrar ahí y nadie podía
 * revisar desde fuera qué estaba afirmando sobre la empresa.
 *
 * Esto lee `docs/agente-voxti/` y lo aplica por la API —no por SQL— para que
 * pase por los guards y quede en el libro de auditoría como cualquier otro
 * cambio.
 *
 *   IAXTI_API=https://api-staging.iaxti.cl \
 *   IAXTI_TOKEN='...' IAXTI_TENANT=ee3f97ae-... \
 *   node scripts/agente-voxti.mjs --agente b5169546-... [--aplicar]
 *
 * Sin `--aplicar` solo dice qué haría. Es el modo por omisión a propósito:
 * este script reescribe lo que un bot le dice a clientes reales.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(RAIZ, 'docs', 'agente-voxti');

const API = process.env.IAXTI_API;
const TOKEN = process.env.IAXTI_TOKEN;
const TENANT = process.env.IAXTI_TENANT;
const agenteId = process.argv[arg('--agente') + 1];
const aplicar = process.argv.includes('--aplicar');

function arg(n) { return process.argv.indexOf(n); }
function falta(n, v) { if (!v) { console.error(`Falta ${n}.`); process.exit(1); } }
falta('IAXTI_API', API); falta('IAXTI_TOKEN', TOKEN);
falta('IAXTI_TENANT', TENANT); falta('--agente', agenteId);

async function api(ruta, init = {}) {
  const r = await fetch(`${API}/v1${ruta}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
      'x-tenant-id': TENANT,
      ...(init.headers ?? {}),
    },
  });
  const cuerpo = await r.text();
  if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${ruta} → ${r.status} ${cuerpo.slice(0, 300)}`);
  return cuerpo ? JSON.parse(cuerpo) : null;
}

/** El título sale de la primera línea del nombre de archivo, sin el número. */
function tituloDe(archivo) {
  return archivo.replace(/^\d+-/, '').replace(/\.txt$/, '').replace(/-/g, ' ');
}

const archivos = readdirSync(DIR).filter((f) => f.endsWith('.txt')).sort();
const personalidad = readFileSync(join(DIR, '00-personalidad.txt'), 'utf8').trim();
const fuentes = archivos
  .filter((f) => f !== '00-personalidad.txt')
  .map((f) => ({ titulo: tituloDe(f), texto: readFileSync(join(DIR, f), 'utf8').trim() }));

console.log(`Agente ${agenteId} en ${API}/v1`);
console.log(`  personalidad: ${personalidad.split('\n').length} líneas`);
console.log(`  fuentes nuevas: ${fuentes.map((s) => s.titulo).join(', ')}`);

const actuales = await api('/knowledge/sources');
const lista = Array.isArray(actuales) ? actuales : (actuales.items ?? []);
console.log(`  fuentes que ya están: ${lista.map((s) => s.name).join(' · ') || '(ninguna)'}`);

// Lo del evento se va. El resto se deja: no es de este script decidirlo.
const delEvento = lista.filter((s) => /summit|stand|evento/i.test(s.name ?? ''));
console.log(`  se borran por ser del evento: ${delEvento.map((s) => s.name).join(' · ') || '(ninguna)'}`);

if (!aplicar) {
  console.log('\nEnsayo. Volvé a correrlo con --aplicar para que pase de verdad.');
  process.exit(0);
}

await api(`/agents/${agenteId}`, {
  method: 'PUT',
  body: JSON.stringify({ personality: personalidad, objetivo: 'vender' }),
});
console.log('  ✓ personalidad y objetivo actualizados');

for (const s of delEvento) {
  await api(`/knowledge/sources/${s.id}`, { method: 'DELETE' });
  console.log(`  ✓ borrada «${s.name}»`);
}
for (const s of fuentes) {
  await api('/knowledge/sources', {
    method: 'POST',
    body: JSON.stringify({ kind: 'texto', name: s.titulo, content: s.texto }),
  });
  console.log(`  ✓ cargada «${s.titulo}»`);
}

console.log('\nListo. Las fuentes nacen `processing` y tardan ~5 min en indexarse:');
console.log('probar antes de eso mide la ausencia del conocimiento, no el cambio.');
