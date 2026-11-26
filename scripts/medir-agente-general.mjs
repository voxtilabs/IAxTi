#!/usr/bin/env node
// Mide al Agente General con su dataset (#1389), por el PUERTO del producto:
// la misma ruta que usa la web (POST /v1/agente-general), con la instrucción,
// las herramientas y el proveedor que el despliegue tiene configurados. No es
// un curl armado a mano (testing.md, #870): lo que se mide es el producto.
//
//   IAXTI_API_URL=http://localhost:3001 IAXTI_TOKEN=<bearer> IAXTI_TENANT=<uuid> \
//     node scripts/medir-agente-general.mjs [vueltas] [salida.json]
//
// Sin IAXTI_TOKEN entra como ADMIN por /entrar-local (solo en local, con la
// web en IAXTI_WEB_URL o http://localhost:3002) y toma la sesión de ahí.
// Cada vuelta cuesta una conversación con el proveedor: 5 casos × 3 vueltas
// son 15 llamadas.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataset = JSON.parse(readFileSync(join(raiz, 'packages/modules/agents/evals/dataset-agente-general.json'), 'utf8'));
const VUELTAS = Number(process.argv[2] ?? 3);
const SALIDA = process.argv[3];

async function sesion() {
  if (process.env.IAXTI_TOKEN && process.env.IAXTI_TENANT && process.env.IAXTI_API_URL) {
    return { url: process.env.IAXTI_API_URL.replace(/\/+$/, ''), authorization: `Bearer ${process.env.IAXTI_TOKEN}`, tenant: process.env.IAXTI_TENANT };
  }
  const require = createRequire(join(raiz, 'apps/web/package.json'));
  const { chromium } = require('@playwright/test');
  const web = (process.env.IAXTI_WEB_URL ?? 'http://localhost:3002').replace(/\/+$/, '');
  const b = await chromium.launch();
  const page = await (await b.newContext()).newPage();
  let cab = null;
  page.on('request', (r) => {
    const h = r.headers();
    if (!cab && h.authorization && h['x-tenant-id']) cab = { url: new URL(r.url()).origin, authorization: h.authorization, tenant: h['x-tenant-id'] };
  });
  await page.goto(`${web}/entrar-local`);
  await page.getByTestId('entrar-admin').click();
  await page.waitForURL(`${web}/`);
  for (let i = 0; i < 40 && !cab; i++) await page.waitForTimeout(250);
  await b.close();
  if (!cab) throw new Error('No pude tomar la sesión de /entrar-local. Pasa IAXTI_API_URL, IAXTI_TOKEN e IAXTI_TENANT.');
  return cab;
}

const { maxPreguntas, maxPalabras, prohibido } = dataset.criterio;
const cab = await sesion();
const filas = [];
for (const caso of dataset.casos) {
  for (let v = 0; v < VUELTAS; v++) {
    const r = await fetch(`${cab.url}/v1/agente-general`, {
      method: 'POST',
      headers: { authorization: cab.authorization, 'x-tenant-id': cab.tenant, 'content-type': 'application/json' },
      body: JSON.stringify({ turnos: [{ role: 'user', content: caso.texto }], pantalla: 'asistentes' }),
    });
    const j = await r.json().catch(() => ({}));
    const texto = String(j.texto ?? '');
    const preguntas = (texto.match(/\?/g) ?? []).length;
    const palabras = texto.split(/\s+/).filter(Boolean).length;
    const propone = Boolean(j.propuesta);
    const jerga = prohibido.filter((p) => texto.toLowerCase().includes(p));
    const pasa = r.ok && jerga.length === 0 && (propone || (preguntas <= maxPreguntas && palabras <= maxPalabras));
    filas.push({ caso: caso.id, vuelta: v + 1, status: r.status, preguntas, palabras, propone, jerga, pasa, texto });
    console.log(`${caso.id} #${v + 1}: ${r.status} ?=${preguntas} palabras=${palabras} propone=${propone}${jerga.length ? ` jerga=${jerga}` : ''} ${pasa ? 'PASA' : 'NO'}`);
  }
}
if (SALIDA) writeFileSync(SALIDA, JSON.stringify(filas, null, 2));
const ok = filas.filter((f) => f.pasa).length;
const palabras = filas.map((f) => f.palabras).sort((a, b) => a - b);
console.log(`\n${ok}/${filas.length} pasan · proponen ${filas.filter((f) => f.propone).length} · mediana ${palabras[Math.floor(palabras.length / 2)]} palabras`);
process.exit(ok === filas.length ? 0 : 1);
