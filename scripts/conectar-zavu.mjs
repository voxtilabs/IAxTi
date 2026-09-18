#!/usr/bin/env node
// Conecta un canal de Zavu a un tenant, de punta a punta (#42, #56).
//
//   ZAVU_API_KEY=... node scripts/conectar-zavu.mjs \
//     --tenant <uuid> --nombre "WhatsApp Demo" \
//     --base-url https://api-staging.iaxti.cl [--sender snd_xxx] [--kind whatsapp]
//
// Sin --tenant solo LISTA lo que hay: sirve para mirar antes de tocar nada.
import { createPool, withTenant } from '@iaxti/db';
import {
  clienteZavu,
  conectarSender,
  elegirSender,
  llaveSirveParaAmbiente,
  quienSoy,
} from '@iaxti/module-whatsapp';

function arg(nombre, pordefecto) {
  const i = process.argv.indexOf(`--${nombre}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : pordefecto;
}

const apiKey = process.env.ZAVU_API_KEY;
if (!apiKey) {
  console.error('Falta ZAVU_API_KEY en el entorno. La credencial NO se pasa por argumento:');
  console.error('queda en el historial del shell y ahí ya es un secreto filtrado.');
  process.exit(1);
}

const tenantId = arg('tenant');
const kind = arg('kind', 'whatsapp');
const baseUrl = arg('base-url', process.env.API_URL_PUBLIC);
const nombre = arg('nombre', 'Canal de Zavu');
const senderPedido = arg('sender');
const credentialRef = arg('credential-ref', 'ZAVU_API_KEY');
const webhookSecretRef = arg('webhook-secret-ref', 'ZAVU_WEBHOOK_SECRET');

const llamar = clienteZavu(apiKey);

// Antes que nada: ¿esta llave puede tocar este ambiente? Lo responde la
// API (`isTestMode`), no el prefijo del token — un token se renombra, la
// respuesta de la API no.
const proyecto = await quienSoy(llamar);
const veredicto = llaveSirveParaAmbiente(proyecto, process.env.IAXTI_ENV);
console.log(
  `\nProyecto: ${proyecto.project.name} · llave de ${proyecto.isTestMode ? 'PRUEBA' : 'PRODUCCIÓN'}` +
    ` · ambiente: ${process.env.IAXTI_ENV ?? 'sin declarar'}`,
);
// El veredicto NO corta acá: mirar nunca fue el problema.
//
// Estaba puesto antes de listar, así que para ver qué senders hay había que
// declarar IAXTI_ENV=production — o sea, desarmar la protección para hacer
// una consulta de solo lectura. Eso entrena a saltársela, y una guarda que
// se desarma por costumbre deja de ser una guarda. Se aplica más abajo,
// justo antes de lo único que escribe.

// La API pagina con `{items, nextCursor}`. Lo descubrí llamándola: el
// script leía `data` y reportaba "0 senders" con el proyecto lleno.
const respuesta = await llamar('/senders');
const senders = Array.isArray(respuesta)
  ? respuesta
  : (respuesta.items ?? respuesta.data ?? []);

console.log(`\nSenders del proyecto (${senders.length}):`);
for (const s of senders) {
  const canales = (s.channels ?? []).join(', ') || 'sin canales';
  console.log(`  ${s.id}  ${s.name}  [${canales}]${s.isDefault ? '  (por defecto)' : ''}`);
}

if (!tenantId) {
  console.log('\nSin --tenant no toco nada. Para conectar:');
  console.log('  node scripts/conectar-zavu.mjs --tenant <uuid> --base-url https://api-staging.iaxti.cl');
  process.exit(0);
}
if (!baseUrl) {
  console.error('\nFalta --base-url (o API_URL_PUBLIC): sin eso el webhook no tiene a dónde llegar.');
  process.exit(1);
}

// Acá sí: de aquí para abajo se ESCRIBE (se crea la cuenta y se le cambia
// el webhook al sender en Zavu). Una llave de producción en un ambiente que
// no es producción manda mensajes reales a clientes reales.
if (!veredicto.ok) {
  console.error(`\n${veredicto.motivo}`);
  process.exit(1);
}

const elegido = elegirSender(senders, kind, senderPedido);
if ('error' in elegido) {
  console.error(`\n${elegido.error}`);
  for (const s of elegido.candidatos) console.error(`  --sender ${s.id}   ${s.name}`);
  process.exit(1);
}

const pool = createPool();
try {
  const res = await withTenant(pool, tenantId, (client) =>
    conectarSender(client, {
      tenantId,
      nombre,
      sender: elegido.sender,
      baseUrl,
      credentialRef,
      webhookSecretRef,
      llamar,
      kind,
    }),
  );

  console.log(`\nListo. Canal ${kind} conectado al tenant ${tenantId}:`);
  console.log(`  cuenta de canal: ${res.account.id}`);
  console.log(`  sender:          ${res.senderId}`);
  console.log(`  webhook:         ${res.webhookUrl}`);
  if (res.webhookSecret) {
    console.log(`\nGuarda ESTO como ${webhookSecretRef} en el entorno (Zavu no lo muestra de nuevo):`);
    console.log(`  ${res.webhookSecret}`);
  }
  for (const aviso of res.avisos) console.log(`\n⚠ ${aviso}`);
  console.log('\nPrueba de verdad: mándale un mensaje al número y mira que llegue a la bandeja.');
  console.log('El /health dice que el proceso vive, no que el producto funciona.');
} finally {
  await pool.end();
}
