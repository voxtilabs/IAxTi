// Vuelca el documento OpenAPI a un archivo. Levanta la app de verdad: el
// documento sale del código, jamás de una copia escrita a mano.
import { writeFileSync } from 'node:fs';
const { createApp } = await import('../apps/api/dist/main.js');
const app = await createApp();
await app.listen(0);
const url = await app.getUrl();
const doc = await (await fetch(`${url}/docs-json`)).json();
writeFileSync(process.argv[2] ?? 'openapi.json', JSON.stringify(doc, null, 2));
console.log(`operaciones: ${Object.values(doc.paths).reduce((n, m) => n + Object.keys(m).length, 0)}`);
await app.close();
process.exit(0);
