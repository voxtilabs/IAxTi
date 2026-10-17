// Medición estática de #810 C1. No carga .env, no evalúa interpolaciones y
// no imprime valores. Las líneas comentadas no forman parte del compose.
import { readFileSync } from 'node:fs';

const results = {};
for (const environment of ['prod', 'staging']) {
  const file = `infra/dokploy/docker-compose.${environment}.yml`;
  const variables = new Map();
  for (const [offset, line] of readFileSync(file, 'utf8').split('\n').entries()) {
    if (line.trimStart().startsWith('#')) continue;
    for (const match of line.matchAll(/\$\{([A-Z][A-Z0-9_]*)([^}]*)\}/g)) {
      const name = match[1];
      const operator = match[2].startsWith(':?') ? ':?'
        : match[2].startsWith(':-') ? ':-' : match[2] === '' ? 'sin operador' : 'otro';
      if (operator === 'otro') throw new Error(`Interpolación no contemplada: ${file}:${offset + 1}`);
      const occurrences = variables.get(name) ?? [];
      occurrences.push({ line: offset + 1, operator });
      variables.set(name, occurrences);
    }
  }
  const entries = [...variables].sort(([a], [b]) => a.localeCompare(b)).map(([name, occurrences]) => ({
    name, required: occurrences.some(item => item.operator === ':?'), occurrences,
  }));
  results[environment] = {
    file,
    unique_variables: entries.length,
    required_variables: entries.filter(entry => entry.required).length,
    not_required_variables: entries.filter(entry => !entry.required).length,
    interpolation_occurrences: entries.reduce((total, entry) => total + entry.occurrences.length, 0),
    occurrences_without_required_operator: entries.flatMap(entry => entry.occurrences).filter(item => item.operator !== ':?').length,
    variables: entries,
  };
}
console.log(JSON.stringify(results, null, 2));
