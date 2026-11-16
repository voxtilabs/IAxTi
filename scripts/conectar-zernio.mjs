#!/usr/bin/env node
// Conecta un WhatsApp de Zernio a un tenant, con un perfil de Zernio por
// tenant y una llave que solo ve ese perfil (#1321, ADR-0032/0033).
//
// La llave del OPERADOR (alcance completo) va en el entorno, nunca por
// argumento: queda en el historial del shell y ahí ya es un secreto filtrado.
//
//   1. Mirar (no toca nada):
//        ZERNIO_API_KEY=… node scripts/conectar-zernio.mjs
//
//   2. El perfil del negocio y el enlace para conectar su número EN ese perfil:
//        ZERNIO_API_KEY=… node scripts/conectar-zernio.mjs --tenant <uuid> --nombre "VoxTi Labs"
//
//   3. Con el número ya conectado, darlo de alta en IAxTi:
//        ZERNIO_API_KEY=… DATABASE_URL=… IAXTI_ENV=staging ZERNIO_ENVIOS_REALES=1 \
//          node scripts/conectar-zernio.mjs --tenant <uuid> --nombre "VoxTi Labs" \
//            --cuenta <id de la cuenta de Zernio> --base-url https://api-staging.iaxti.cl \
//            --credential-ref ZERNIO_LLAVE_VOXTI --webhook-secret-ref ZERNIO_WEBHOOK_SECRET_VOXTI
//
// El paso 3 imprime UNA vez la llave del negocio y el secreto del webhook:
// van al entorno del despliegue con esos dos nombres, y después un deploy.
import { createPool, withTenant } from '@iaxti/db';
import {
  asegurarAdaptadorDeZernio,
  baseDeZernio,
  cuentaDeZernioYaConectada,
  cuentaDelPerfil,
  darDeAltaCuentaDeZernio,
  enlaceParaConectar,
  ErrorDelAlta,
  listarCuentasDelPerfil,
  llamarAZernio,
  llaveDelTenant,
  perfilDelTenant,
  suscribirWebhook,
} from '@iaxti/module-whatsapp';

function arg(nombre, pordefecto) {
  const i = process.argv.indexOf(`--${nombre}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : pordefecto;
}
function salir(mensaje) {
  console.error(`\n${mensaje}`);
  process.exit(1);
}

const apiKey = process.env.ZERNIO_API_KEY;
if (!apiKey) salir('Falta ZERNIO_API_KEY (la llave del operador) en el entorno. No se pasa por argumento.');
const cfg = { apiKey, apiBase: baseDeZernio(), fetchImpl: (...a) => globalThis.fetch(...a) };

const tenantId = arg('tenant');
const nombre = arg('nombre', 'WhatsApp');
const zernioAccountId = arg('cuenta');
const baseUrl = arg('base-url', process.env.API_URL_PUBLIC);
const credentialRef = arg('credential-ref');
const webhookSecretRef = arg('webhook-secret-ref');

try {
  if (!tenantId) {
    // Solo mirar: los perfiles que ya son de algún negocio de IAxTi.
    const r = await llamarAZernio(cfg, '/v1/profiles?includeOverLimit=true');
    const perfiles = (r.profiles ?? []).filter((p) => p.externalId);
    console.log(`\nPerfiles de Zernio con negocio (${perfiles.length}):`);
    for (const p of perfiles) console.log(`  ${p._id}  ${p.name}  → tenant ${p.externalId}  (${p.accountCount ?? 0} cuentas)`);
    console.log('\nSin --tenant no toco nada.');
    process.exit(0);
  }
  if (!/^[0-9a-f-]{36}$/i.test(tenantId)) salir('--tenant tiene que ser el uuid del negocio.');

  const { perfil, creado } = await perfilDelTenant(cfg, { tenantId, nombre });
  console.log(`\nPerfil de Zernio del negocio: ${perfil._id} (${perfil.name})${creado ? ' — recién creado' : ''}`);

  if (!zernioAccountId) {
    const cuentas = (await listarCuentasDelPerfil(cfg, perfil._id)).filter((c) => c.platform === 'whatsapp');
    if (cuentas.length > 0) {
      console.log('\nWhatsApp ya conectados en este perfil:');
      for (const c of cuentas) {
        console.log(`  --cuenta ${c._id}   ${c.displayName ?? c.username ?? ''}${c.needsReconnection ? '  (pide reconectar)' : ''}`);
      }
    }
    const enlace = await enlaceParaConectar(cfg, { profileId: perfil._id });
    console.log('\nPara conectar un número EN el perfil de este negocio, abre:');
    console.log(`  ${enlace}`);
    console.log('\nOjo: si el número hoy está en otro proveedor, confirma con Zernio cómo se migra ANTES de soltarlo de allá.');
    console.log('Mientras el número quede suelto en el medio, nadie recibe nada.');
    process.exit(0);
  }

  // De aquí para abajo se ESCRIBE.
  if (!baseUrl) salir('Falta --base-url (o API_URL_PUBLIC): sin eso el webhook no tiene a dónde llegar.');
  if (!credentialRef || !webhookSecretRef) {
    salir('Faltan --credential-ref y --webhook-secret-ref: los NOMBRES de las variables donde van a vivir la llave y el secreto.');
  }
  // En Zernio no hay llaves de prueba: todo número conectado manda de verdad.
  const esProduccion = process.env.IAXTI_ENV === 'production';
  const reales = !esProduccion && process.env.ZERNIO_ENVIOS_REALES === '1';
  if (!esProduccion && !reales) {
    salir(
      `El ambiente es "${process.env.IAXTI_ENV ?? 'sin declarar'}" y un número de Zernio manda mensajes reales a clientes reales.\n` +
        'Si es lo que quieres, declara ZERNIO_ENVIOS_REALES=1: queda marcado en el canal y el diagnóstico lo muestra.\n' +
        'NO declares IAXTI_ENV=production para pasar: eso le miente al aislamiento por tenant, a Sentry y a los pagos.',
    );
  }

  const cuentaZ = await cuentaDelPerfil(cfg, { profileId: perfil._id, zernioAccountId, plataforma: 'whatsapp' });
  console.log(`Cuenta comprobada en el perfil: ${cuentaZ._id} (${cuentaZ.displayName ?? cuentaZ.username ?? 'sin nombre'})`);

  asegurarAdaptadorDeZernio();
  const pool = createPool();
  let cuenta;
  try {
    // Correrlo dos veces no puede dejar dos cuentas: si ya está, se reusa y
    // solo se rehace lo de Zernio (webhook y llave).
    cuenta = await withTenant(pool, tenantId, (c) => cuentaDeZernioYaConectada(c, tenantId, zernioAccountId));
    if (cuenta) {
      console.log(`La cuenta ya estaba en IAxTi: ${cuenta.id}. Se rehacen el webhook y la llave.`);
    } else {
      ({ account: cuenta } = await withTenant(pool, tenantId, (c) =>
        darDeAltaCuentaDeZernio(c, {
          tenantId,
          nombre,
          zernioAccountId,
          zernioProfileId: perfil._id,
          // Solo si parece un teléfono: el nombre visible de la cuenta no lo es.
          displayPhone: [cuentaZ.displayName, cuentaZ.username].find((v) => /^\+?\d[\d\s-]{6,}$/.test(v ?? '')),
          credentialRef,
          webhookSecretRef,
          enviosReales: reales,
          actor: 'script:conectar-zernio',
        }),
      ));
    }
  } finally {
    await pool.end();
  }

  const url = `${baseUrl.replace(/\/+$/, '')}/webhooks/channels/${cuenta.id}`;
  const webhook = await suscribirWebhook(cfg, { url, profileId: perfil._id, zernioAccountId });
  const llave = await llaveDelTenant(cfg, { tenantId, profileId: perfil._id });

  console.log(`\nCanal de WhatsApp por Zernio conectado al negocio ${tenantId}:`);
  console.log(`  cuenta de canal: ${cuenta.id}`);
  console.log(`  webhook:         ${url} (${webhook.creado ? 'nuevo' : 'actualizado'}, atado al perfil y a la cuenta)`);
  console.log('\nGuarda ESTO en el entorno del despliegue (Zernio no lo muestra de nuevo):');
  console.log(`  ${credentialRef}=${llave.llave}`);
  console.log(`  ${webhookSecretRef}=${webhook.secreto}`);
  // Las llaves de altas anteriores siguen vivas hasta que alguien las borre.
  // No se borran acá: el despliegue todavía usa la vieja, y borrarla antes del
  // deploy deja al canal sin poder mandar.
  const todas = await llamarAZernio(cfg, '/v1/api-keys').catch(() => ({}));
  const viejas = (todas.apiKeys ?? todas.keys ?? []).filter(
    (k) => k.id !== llave.id && k.scope === 'profiles' && (k.profileIds ?? []).includes(perfil._id),
  );
  if (viejas.length) {
    console.log('\nDespués del deploy, borra en Zernio las llaves anteriores de este perfil:');
    for (const k of viejas) console.log(`  ${k.id}  ${k.name ?? ''}  ${k.keyPreview ?? ''}`);
  }
  console.log('\nHasta el deploy, los webhooks responden 401 y el diagnóstico lo dice.');
  console.log('Prueba de verdad: escribe al número y comprueba recepción y respuesta en la bandeja.');
  if (reales) console.log('\n*** ENVÍOS REALES fuera de producción: queda marcado en el canal. ***');
} catch (e) {
  if (e instanceof ErrorDelAlta) salir(e.message);
  throw e;
}
