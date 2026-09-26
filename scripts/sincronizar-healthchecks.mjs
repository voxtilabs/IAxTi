import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Usa la dependencia YAML ya declarada; no instala herramientas en el VPS.
const require = createRequire(new URL('../packages/core/package.json', import.meta.url));
const { parse, parseDocument } = require('yaml');

/**
 * Qué claves de entorno se completan en el Compose raw, y por qué esta y no todas
 * (#573).
 *
 * Empecé por la regla general —«toda clave que el YAML declara como paso de una
 * variable del proyecto»— y la angosté al medirla, porque habría hecho alcanzable
 * una familia de fallos peor que el que venía a arreglar.
 *
 * El problema: si la variable del proyecto no está puesta, Compose sustituye
 * CADENA VACÍA, y `??` no atrapa la cadena vacía. Así que una clave que hoy no
 * existe —y por lo tanto llega `undefined` y cae a su por-defecto— pasaría a
 * llegar `''` y a NO caer. Tres casos concretos, medidos en el YAML de staging:
 *
 *   IAXTI_ENV          `?? 'development'` en rls.ts, que es la comprobación de
 *                      aislamiento por tenant, y `?? 'local'` en telemetry
 *   AUDIT_EXPORT_SECRET `?? null` en la firma de la exportación de auditoría:
 *                      firmar con secreto vacío no es lo mismo que no firmar
 *   PUBLIC_API_URL     `?? 'https://api-staging…'` en los LINKS DE PAGO
 *
 * Las que traen `:-` en el YAML (`${X:-defecto}`) no tienen este problema: Compose
 * trata la vacía como ausente. Las que no, sí.
 *
 * Así que acá va solo `IAXTI_IMAGE`, que es la que está rota y la que no puede
 * hacer daño: nadie la lee con `??` para decidir nada —`versionDelBuild()` y
 * `releaseDeLaImagen()` la tratan como opcional— y su ausencia ya se está pagando.
 *
 * La familia de `??` contra la cadena vacía va en su propio issue. Arreglarla
 * primero y después generalizar esto es el orden correcto; hacerlo al revés es
 * cambiar un fallo visible por tres invisibles en rutas de plata y de auditoría.
 */
const CLAVES_QUE_SE_COMPLETAN = new Set(['IAXTI_IMAGE']);

/**
 * Parche mínimo para Compose raw; nunca reemplaza configuración del operador.
 *
 * Sincroniza dos cosas: los healthchecks (#396) y las claves de entorno de paso
 * que falten (#573). Lo segundo se agregó porque `IAXTI_IMAGE` estaba declarado en
 * el compose del repo y NUNCA llegaba al contenedor: `/health` reportaba
 * `sha: null` y —más grave— el `release` de Sentry venía vacío desde #392, que era
 * todo el motivo de esa variable. Declarado en un lado, aplicado en ninguno.
 */
export function parcheHealthchecks(actual, canonicalText) {
  const sources = ['raw', 'git', 'github', 'gitlab', 'bitbucket', 'gitea'];
  if (!sources.includes(actual?.sourceType)) throw new Error('Origen de Compose desconocido.');
  if (actual.sourceType !== 'raw') return {};

  try {
    if (typeof actual.composeFile !== 'string') throw new Error();
    const doc = parseDocument(actual.composeFile, { merge: true });
    if (doc.errors.length) throw new Error();
    const current = doc.toJS({ maxAliasCount: 100 });
    const canonical = parse(canonicalText, { merge: true });
    let changed = false;
    for (const service of ['workers', 'agents']) {
      const running = current?.services?.[service];
      const health = canonical?.services?.[service]?.healthcheck;
      if (!running || typeof running !== 'object' || !health || !Array.isArray(health.test)) throw new Error();
      if (running.healthcheck !== undefined) {
        if (!running.healthcheck || running.healthcheck.disable === true) throw new Error();
        continue;
      }
      doc.setIn(['services', service, 'healthcheck'], doc.createNode(health));
      changed = true;
    }

    // Las claves de paso que falten, en TODOS los servicios del canónico y no
    // solo en workers y agents: la de la versión la necesitan los cinco.
    for (const [service, definicion] of Object.entries(canonical?.services ?? {})) {
      const running = current?.services?.[service];
      // Un servicio que el operador no tiene no se inventa: este parche completa,
      // no crea.
      if (!running || typeof running !== 'object') continue;
      const canonicalEnv = definicion?.environment;
      if (!canonicalEnv || typeof canonicalEnv !== 'object' || Array.isArray(canonicalEnv)) continue;
      const runningEnv = running.environment;
      // Con `environment` en forma de lista (`- CLAVE=valor`) no se toca nada: es
      // otra forma válida de Compose y mezclarla a mano es cómo se rompen las dos.
      if (runningEnv !== undefined && (typeof runningEnv !== 'object' || Array.isArray(runningEnv))) {
        throw new Error();
      }
      for (const [clave, valor] of Object.entries(canonicalEnv)) {
        if (!CLAVES_QUE_SE_COMPLETAN.has(clave)) continue;
        if (runningEnv && Object.prototype.hasOwnProperty.call(runningEnv, clave)) continue;
        doc.setIn(['services', service, 'environment', clave], valor);
        changed = true;
      }
    }

    return changed ? { composeFile: doc.toString() } : {};
  } catch {
    // Los errores del parser pueden contener líneas con secretos del documento.
    throw new Error('No se pudieron validar los healthchecks de Compose; no se aplicó el parche.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const actual = JSON.parse(readFileSync(0, 'utf8'));
    const canonical = readFileSync(process.argv[2], 'utf8');
    process.stdout.write(JSON.stringify(parcheHealthchecks(actual, canonical)));
  } catch {
    console.error('No se pudo preparar el parche de healthchecks; la configuración no se modificó.');
    process.exitCode = 1;
  }
}
