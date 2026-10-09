// Vuelca el documento OpenAPI a un archivo. Levanta la app de verdad: el
// documento sale del código, jamás de una copia escrita a mano.
//
// OJO con el orden: esto carga `apps/api/dist`, así que corre contra el ÚLTIMO
// BUILD y no contra el código de ahora. Corrido a mano sin compilar antes,
// genera un catálogo al que le faltan las rutas nuevas y además BORRA las que
// el build viejo no tenía — pasó con la ruta de #700, que desapareció del
// catálogo al regenerarlo sin compilar. Por eso `pnpm catalogo` compila primero
// y el script de pre-push lo corre después del paso de build.
import { writeFileSync } from 'node:fs';
const { createApp } = await import('../apps/api/dist/main.js');
// Los esquemas de cuerpo (#524) se registran al declararse: importar el módulo
// de la app ya los deja en el mapa. Van en el documento como extensión porque
// Nest no publica la forma del cuerpo —los `@Body()` eran tipos inline— y el
// catálogo del Agente General (#492) la necesita: sin ella el agente llamaría
// cada herramienta a ciegas.
const { ESQUEMAS_DE_CUERPO } = await import('../apps/api/dist/validar.js');
const app = await createApp();
await app.listen(0);
const url = await app.getUrl();
const doc = await (await fetch(`${url}/docs-json`)).json();
doc['x-iaxti-cuerpos'] = Object.fromEntries(ESQUEMAS_DE_CUERPO);
writeFileSync(process.argv[2] ?? 'openapi.json', JSON.stringify(doc, null, 2));
console.log(`cuerpos con esquema: ${ESQUEMAS_DE_CUERPO.size}`);
console.log(`operaciones: ${Object.values(doc.paths).reduce((n, m) => n + Object.keys(m).length, 0)}`);
await app.close();
process.exit(0);
