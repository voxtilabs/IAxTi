import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Sincroniza con Dokploy la copia del compose de staging (#1359) y comprueba
// que quedó sincronizada. Es la regla completa en un solo archivo, en dos
// pasos que el workflow encadena:
//
//   1. Armar el payload del `compose.update` (modo por defecto):
//
//        cat compose.one.json | node scripts/sincronizar-compose.mjs \
//            infra/dokploy/docker-compose.staging.yml
//
//      stdin es el `compose.one` FRESCO de Dokploy, jamás un snapshot:
//      `compose.update` reemplaza el env ENTERO, y reconstruirlo de una copia
//      vieja pisó el `IMAGE` y dejó el deploy siguiente en «No such image».
//      El `composeFile` del payload es el contenido LITERAL del archivo del
//      repo — que con `sourceType: raw` Dokploy no vuelve a leer solo (#396),
//      y ese era todo el motivo de #1359: cada cambio al YAML quedaba sin
//      efecto hasta que alguien lo pegaba a mano en el panel.
//
//      La salida lleva el env completo, con secretos: va directa a la
//      llamada y nunca al log.
//
//   2. Verificar (--verificar):
//
//        cat compose.one.json | node scripts/sincronizar-compose.mjs \
//            --verificar infra/dokploy/docker-compose.staging.yml [antes.json]
//
//      Compara la copia de Dokploy contra el repo. Sin `antes.json` mira solo
//      el `composeFile`: así se usa de compuerta — «¿ya coincide y no hay
//      nada que sincronizar?». Con `antes.json` (el `compose.one` de antes del
//      update, en un archivo privado) comprueba además que el env no perdió
//      ni ganó variables: compara NOMBRES y no valores, porque los valores
//      del env son secretos y jamás van al log.
//
//      Cuando algo difiere, lo que se imprime también son NOMBRES —
//      servicios, claves, variables — y no valores: la copia de Dokploy puede
//      traer secretos pegados a mano, y el log de Actions lo lee cualquiera
//      con acceso al repo.
//
// Corre a mano igual que desde el workflow: todo entra por stdin, argv y el
// env que el llamador ya tiene.

const require = createRequire(new URL('../packages/core/package.json', import.meta.url));
const { parse } = require('yaml');

function falla(mensaje) {
  console.error(mensaje);
  process.exit(1);
}

function leerArchivo(ruta) {
  try {
    return readFileSync(ruta, 'utf8');
  } catch {
    return falla(`No pude leer ${ruta}.`);
  }
}

function leerStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return falla('No pude leer stdin.');
  }
}

function deJson(texto, que) {
  try {
    return JSON.parse(texto);
  } catch {
    return falla(`${que} no es JSON legible. Suele ser una pantalla de Cloudflare Access en vez de la API. Nada se tocó.`);
  }
}

function deYaml(texto, que) {
  try {
    return parse(texto, { merge: true });
  } catch {
    // El error del parser puede citar líneas del documento: no se imprime.
    return falla(`${que} no parsea como YAML. El detalle no se imprime porque puede traer contenido del documento. Nada se envió.`);
  }
}

// Nombres de variables de un env de Dokploy («CLAVE=valor» → «CLAVE»), sin
// valores. Sin valores no solo es prudencia: es lo único que hace falta para
// la comparación, que pregunta por el CONJUNTO de variables.
function nombresDelEnv(env) {
  if (typeof env !== 'string') return new Set();
  const nombres = env
    .split('\n')
    .map((linea) => /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(linea)?.[1])
    .filter(Boolean);
  return new Set(nombres);
}

// Igualdad estructural, insensible al orden de las claves y al formato del
// YAML: lo que Dokploy APLICA es el documento y no el texto con que está
// escrito. Exigir igualdad de bytes haría fallar la verificación por un
// cambio de comillas o de orden, y un rojo que no habla de un problema real
// enseña a ignorar los rojos.
function canonico(valor) {
  if (Array.isArray(valor)) return valor.map(canonico);
  if (valor !== null && typeof valor === 'object') {
    return Object.fromEntries(
      Object.keys(valor)
        .sort()
        .map((clave) => [clave, canonico(valor[clave])]),
    );
  }
  return valor;
}

const mismoDocumento = (a, b) => JSON.stringify(canonico(a)) === JSON.stringify(canonico(b));

const esMapa = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Qué difiere entre el compose de Dokploy y el del repo, dicho con NOMBRES y
// por dónde: la lista es para actuar («falta services.workers»), no para
// admirar. Los valores no se imprimen jamás.
function diferencias(actual, delRepo) {
  const lineas = [];
  const nivel = (prefijo, a, c, fuera) => {
    for (const clave of new Set([...Object.keys(a ?? {}), ...Object.keys(c ?? {})])) {
      if (fuera !== undefined && fuera.has(clave)) continue;
      const enA = Object.prototype.hasOwnProperty.call(a ?? {}, clave);
      const enC = Object.prototype.hasOwnProperty.call(c ?? {}, clave);
      if (!enA) { lineas.push(`${prefijo}${clave}: falta en Dokploy`); continue; }
      if (!enC) { lineas.push(`${prefijo}${clave}: no está en el repo`); continue; }
      if (!mismoDocumento(a[clave], c[clave])) lineas.push(`${prefijo}${clave}: difiere`);
    }
  };
  nivel('', actual, delRepo, new Set(['services']));
  const serviciosA = actual?.services ?? {};
  const serviciosC = delRepo?.services ?? {};
  for (const servicio of new Set([...Object.keys(serviciosA), ...Object.keys(serviciosC)])) {
    const prefijo = `services.${servicio}.`;
    if (!esMapa(serviciosA[servicio])) { lineas.push(`${prefijo.slice(0, -1)}: falta en Dokploy`); continue; }
    if (!esMapa(serviciosC[servicio])) { lineas.push(`${prefijo.slice(0, -1)}: no está en el repo`); continue; }
    nivel(prefijo, serviciosA[servicio], serviciosC[servicio], new Set(['environment']));
    // `environment` con nombres de variables y no con un «difiere» de caja:
    // es lo que #1358 hizo invisible, y el nombre es lo que se corrige.
    const eA = serviciosA[servicio].environment;
    const eC = serviciosC[servicio].environment;
    if (esMapa(eA) && esMapa(eC)) nivel(`${prefijo}environment.`, eA, eC);
  }
  return lineas;
}

function mainPayload(repoPath) {
  const actual = deJson(leerStdin(), 'El compose.one de Dokploy');
  const repo = leerArchivo(repoPath);

  // Con otro origen, el archivo versionado no gobierna esa copia: decirlo y
  // no mandar nada. El deploy de imágenes sigue su curso; esto no es su fallo.
  if (actual?.sourceType !== 'raw') {
    console.error('El compose de Dokploy no es de tipo raw: el archivo del repo no gobierna esa copia. No hay nada que sincronizar.');
    process.exit(0);
  }

  // La guarda que #573 puso en el deploy, acá también: `compose.update`
  // reemplaza el env ENTERO, y mandarlo vacío borra la configuración del
  // stack — todas las credenciales que el operador puso en el panel.
  if (typeof actual.env !== 'string' || !actual.env.trim()) {
    return falla('El env de Dokploy vino vacío o ilegible. Un compose.update con eso borra la configuración del stack (#573): no se envía nada.');
  }

  // El repo tiene que parsear ANTES de mandarse: un YAML roto guardado en
  // Dokploy tumba cada deploy hasta que alguien lo repare a mano en el panel.
  deYaml(repo, 'El compose del repo');

  process.stdout.write(JSON.stringify({ env: actual.env, composeFile: repo }));
}

function mainVerificar(repoPath, antesPath) {
  const post = deJson(leerStdin(), 'El compose.one posterior');
  const repo = leerArchivo(repoPath);

  if (typeof post.composeFile !== 'string' || post.composeFile !== repo) {
    // Texto distinto —o copia vacía—: ¿difiere de verdad o solo el formato?
    const a = deYaml(typeof post.composeFile === 'string' ? post.composeFile : '', 'El composeFile de Dokploy');
    const c = deYaml(repo, 'El compose del repo');
    if (!mismoDocumento(a, c)) {
      console.error('El composeFile de Dokploy NO quedó igual al del repo:');
      for (const linea of diferencias(a, c)) console.error(`  - ${linea}`);
      console.error('  Valores no se imprimen: la copia de Dokploy puede traer secretos pegados a mano.');
      process.exit(1);
    }
    // Estructuralmente igual con formato distinto: mismo compose, pasa.
  }

  if (antesPath !== undefined) {
    const antes = deJson(leerArchivo(antesPath), 'El compose.one de antes del update');
    const nombresAntes = nombresDelEnv(antes.env);
    const nombresPost = nombresDelEnv(post.env);
    const faltan = [...nombresAntes].filter((n) => !nombresPost.has(n));
    const sobran = [...nombresPost].filter((n) => !nombresAntes.has(n));
    if (faltan.length > 0 || sobran.length > 0) {
      console.error('El env de Dokploy no conservó sus variables:');
      if (faltan.length > 0) console.error(`  - faltan: ${faltan.join(', ')}`);
      if (sobran.length > 0) console.error(`  - sobran: ${sobran.join(', ')}`);
      console.error('  Nombres y no valores: los valores del env son secretos.');
      process.exit(1);
    }
  }

  console.error(antesPath !== undefined
    ? 'La copia de Dokploy quedó igual al repo: compose idéntico y las mismas variables de entorno.'
    : 'La copia de Dokploy ya coincide con el repo.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let args = process.argv.slice(2);
  const verificar = args[0] === '--verificar';
  if (verificar) args = args.slice(1);
  const [repoPath, antesPath] = args;
  if (!repoPath) {
    console.error('Uso: sincronizar-compose.mjs [--verificar] <compose-del-repo> [<antes.json>]');
    process.exit(1);
  }
  // El catch no imprime el error crudo: un mensaje de parser o de red puede
  // traer contenido del documento o del env, y el log es público.
  try {
    if (verificar) mainVerificar(repoPath, antesPath);
    else mainPayload(repoPath);
  } catch {
    console.error(verificar
      ? 'No se pudo comparar la copia de Dokploy con el del repo; nada se modificó.'
      : 'No se pudo armar el payload del compose; nada se envió a Dokploy.');
    process.exit(1);
  }
}
