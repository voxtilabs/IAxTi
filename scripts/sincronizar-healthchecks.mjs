import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Usa la dependencia YAML ya declarada; no instala herramientas en el VPS.
const require = createRequire(new URL('../packages/core/package.json', import.meta.url));
const { parse, parseDocument } = require('yaml');

/** Parche mínimo para Compose raw; nunca reemplaza configuración del operador. */
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
