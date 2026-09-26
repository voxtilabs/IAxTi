/**
 * El catálogo de herramientas del Agente General (#492, ADR-0025).
 *
 * Dos fuentes, las dos derivadas del CÓDIGO — ninguna escrita a mano:
 *
 *  1. **El documento OpenAPI** (`/docs-json` de la app levantada de verdad)
 *     da el inventario: ruta, verbo, resumen y —desde #492— el permiso y el
 *     módulo, que los decoradores `RequirePermission`/`RequireModule`
 *     escriben como extensiones `x-iaxti-*`.
 *  2. **El AST de los controladores** da la FORMA de los argumentos. Nest no
 *     la publica en el documento (los `@Body() body: { ... }` son tipos
 *     inline sin plugin de Swagger), y sin forma el modelo adivina campos y
 *     la llamada falla.
 *
 * Lo único que no sale de acá es lo que una máquina no puede inferir: la
 * descripción en español pensada para el modelo y si la acción es
 * reversible. Eso vive curado en `catalogo-curado.ts`.
 *
 * Uso: node scripts/generar-catalogo-herramientas.mjs <openapi.json>
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const RAIZ = new URL('..', import.meta.url).pathname;
const FUENTES = join(RAIZ, 'apps/api/src');

function archivos(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) archivos(p, acc);
    else if (/\.ts$/.test(p) && !/\.d\.ts$/.test(p)) acc.push(p);
  }
  return acc;
}

/** Un tipo de TypeScript a JSON Schema, en el subconjunto que usan los controladores. */
function esquemaDeTipo(nodo) {
  if (!nodo) return { type: 'string' };
  if (ts.isParenthesizedTypeNode(nodo)) return esquemaDeTipo(nodo.type);
  switch (nodo.kind) {
    case ts.SyntaxKind.StringKeyword:
      return { type: 'string' };
    case ts.SyntaxKind.NumberKeyword:
      return { type: 'number' };
    case ts.SyntaxKind.BooleanKeyword:
      return { type: 'boolean' };
    case ts.SyntaxKind.NullKeyword:
      return { type: 'null' };
    case ts.SyntaxKind.UnknownKeyword:
    case ts.SyntaxKind.AnyKeyword:
      return {};
  }
  if (ts.isLiteralTypeNode(nodo)) {
    if (ts.isStringLiteral(nodo.literal)) return { const: nodo.literal.text };
    if (nodo.literal.kind === ts.SyntaxKind.NullKeyword) return { type: 'null' };
    if (nodo.literal.kind === ts.SyntaxKind.TrueKeyword) return { const: true };
    if (nodo.literal.kind === ts.SyntaxKind.FalseKeyword) return { const: false };
  }
  if (ts.isArrayTypeNode(nodo)) return { type: 'array', items: esquemaDeTipo(nodo.elementType) };
  if (ts.isUnionTypeNode(nodo)) {
    const partes = nodo.types.map(esquemaDeTipo);
    // Una unión de literales de texto es un enum: es lo que más ayuda al
    // modelo, porque le dice los valores exactos en vez de "string".
    const consts = partes.filter((p) => 'const' in p);
    if (consts.length && consts.length + partes.filter((p) => p.type === 'null').length === partes.length) {
      return { enum: consts.map((p) => p.const) };
    }
    return { anyOf: partes };
  }
  if (ts.isTypeLiteralNode(nodo)) return esquemaDeObjeto(nodo.members);
  if (ts.isTypeReferenceNode(nodo)) {
    const nombre = nodo.typeName.getText();
    if (nombre === 'Record') return { type: 'object', additionalProperties: true };
    if (nombre === 'Array') return { type: 'array', items: esquemaDeTipo(nodo.typeArguments?.[0]) };
    if (nombre === 'Date') return { type: 'string', description: 'Fecha ISO 8601.' };
    // Un tipo con nombre (ImportField, Trigger, Action…) se deja abierto:
    // resolverlo cruzando módulos sería un compilador entero, y mentir con
    // un `string` es peor que decir "acá va un objeto".
    return {};
  }
  return {};
}

function esquemaDeObjeto(miembros) {
  const properties = {};
  const required = [];
  for (const m of miembros) {
    if (!ts.isPropertySignature(m) || !m.name) continue;
    const nombre = m.name.getText().replace(/^['"]|['"]$/g, '');
    properties[nombre] = esquemaDeTipo(m.type);
    if (!m.questionToken) required.push(nombre);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

/** Los argumentos de cada operación, por `ClaseControlador_metodo`. */
export function argumentosDeLosControladores() {
  const salida = {};
  for (const archivo of archivos(FUENTES)) {
    const sf = ts.createSourceFile(
      relative(RAIZ, archivo),
      readFileSync(archivo, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const visitarClase = (clase) => {
      if (!clase.name) return;
      for (const miembro of clase.members) {
        if (!ts.isMethodDeclaration(miembro) || !miembro.name) continue;
        const verbo = (ts.getDecorators(miembro) ?? []).some(
          (d) =>
            ts.isCallExpression(d.expression) &&
            /^(Get|Post|Put|Patch|Delete|Head|Options|All)$/.test(d.expression.expression.getText()),
        );
        if (!verbo) continue;
        const properties = {};
        const required = [];
        for (const p of miembro.parameters) {
          const deco = (ts.getDecorators(p) ?? []).find((d) => ts.isCallExpression(d.expression));
          if (!deco) continue;
          const clase = deco.expression.expression.getText();
          const arg = deco.expression.arguments[0];
          const nombreArg = arg && ts.isStringLiteral(arg) ? arg.text : undefined;
          if (clase === 'Body') {
            const esquema = esquemaDeTipo(p.type);
            // El cuerpo se APLANA en los argumentos de la herramienta: para
            // el modelo es más simple un objeto plano que `{body:{...}}`.
            if (esquema.type === 'object' && esquema.properties) {
              Object.assign(properties, esquema.properties);
              required.push(...(esquema.required ?? []));
            }
          } else if ((clase === 'Param' || clase === 'Query') && nombreArg) {
            properties[nombreArg] = {
              ...esquemaDeTipo(p.type),
              'x-iaxti-en': clase === 'Param' ? 'ruta' : 'query',
            };
            // Un parámetro de RUTA no es opcional jamás: sin él no hay ruta.
            if (clase === 'Param') required.push(nombreArg);
            else if (!p.questionToken && !p.initializer) required.push(nombreArg);
          }
        }
        salida[`${clase.name.getText()}_${miembro.name.getText()}`] = {
          type: 'object',
          properties,
          ...(required.length ? { required: [...new Set(required)] } : {}),
          additionalProperties: false,
        };
      }
    };
    const recorrer = (n) => {
      if (ts.isClassDeclaration(n)) visitarClase(n);
      ts.forEachChild(n, recorrer);
    };
    recorrer(sf);
  }
  return salida;
}

/**
 * Suma los parámetros que el OpenAPI declara y el AST no pudo ver (#546).
 *
 * El extractor del AST lee `@Param('x')` y `@Query('x')`, que llevan el nombre
 * escrito. Una ruta que recibe `@Query() q: Consulta` —el objeto entero, sin
 * nombre— no le da nada, y las cuatro rutas de auditoría son así: sus diez
 * filtros no llegaban al catálogo, o sea que el agente llamaba la herramienta
 * «con filtros» sin ningún argumento. El filtro se le caía en silencio y
 * contestaba con las últimas entradas de TODO el libro como si fueran las
 * pedidas — sobre auditoría, que es donde alguien pregunta quién cambió algo.
 *
 * El `@ApiQuery` del controlador sí los declara, y el documento es la verdad
 * declarada: de ahí salen. Lo del AST manda cuando ya lo tenía, porque ahí el
 * tipo viene del código.
 */
function conLosParametros(delAst, parametros) {
  const base = delAst ?? { type: 'object', properties: {}, additionalProperties: false };
  if (!Array.isArray(parametros) || parametros.length === 0) return base;
  const properties = { ...(base.properties ?? {}) };
  const required = new Set(base.required ?? []);
  for (const p of parametros) {
    if (!p?.name || (p.in !== 'query' && p.in !== 'path')) continue;
    if (properties[p.name]) continue; // el AST ya lo tenía, con su tipo real
    properties[p.name] = {
      ...(p.schema ?? { type: 'string' }),
      ...(p.description ? { description: p.description } : {}),
      'x-iaxti-en': p.in === 'path' ? 'ruta' : 'query',
    };
    if (p.required || p.in === 'path') required.add(p.name);
  }
  return {
    type: 'object',
    properties,
    ...(required.size ? { required: [...required] } : {}),
    additionalProperties: false,
  };
}

/**
 * Junta lo del AST (ruta y query) con el esquema del cuerpo, si lo hay.
 *
 * El cuerpo se APLANA en los argumentos de la herramienta: para el modelo es
 * más simple un objeto plano que `{body:{...}}`. Es lo mismo que hacía el
 * extractor del AST, para que el cambio a zod no mueva la forma que el agente
 * ya sabe llamar.
 */
function conElCuerpo(delAst, delEsquema) {
  const base = delAst ?? { type: 'object', properties: {}, additionalProperties: false };
  if (!delEsquema) return base;
  const properties = { ...(base.properties ?? {}) };
  const required = new Set(base.required ?? []);
  for (const [nombre, esquema] of Object.entries(delEsquema.properties ?? {})) {
    properties[nombre] = esquema;
  }
  for (const nombre of delEsquema.required ?? []) required.add(nombre);
  return {
    type: 'object',
    properties,
    ...(required.size ? { required: [...required] } : {}),
    additionalProperties: false,
  };
}

/** El catálogo entero a partir del documento OpenAPI ya volcado. */
export function construirCatalogo(documento) {
  const argumentos = argumentosDeLosControladores();
  // Los cuerpos con esquema zod (#524) mandan sobre lo que el AST adivinó: es
  // JSON Schema de verdad, derivado del MISMO esquema que valida la ruta. El
  // AST sigue aportando los `@Param` y `@Query`, que no pasan por zod.
  const cuerpos = documento['x-iaxti-cuerpos'] ?? {};
  const operaciones = {};
  for (const [ruta, metodos] of Object.entries(documento.paths)) {
    for (const [metodo, op] of Object.entries(metodos)) {
      if (!op.operationId) continue;
      operaciones[op.operationId] = {
        metodo: metodo.toUpperCase(),
        // El documento trae `{id}`; el servidor habla `:id`. Se guarda como
        // viene y el ejecutor reemplaza por nombre.
        ruta,
        resumen: op.summary ?? '',
        permiso: op['x-iaxti-permission'] ?? null,
        modulo: op['x-iaxti-module'] ?? null,
        soloSesion: Boolean(op['x-iaxti-auth']),
        argumentos: conElCuerpo(
          conLosParametros(argumentos[op.operationId], op.parameters),
          cuerpos[op.operationId],
        ),
      };
    }
  }
  return Object.fromEntries(Object.entries(operaciones).sort(([a], [b]) => a.localeCompare(b)));
}

/** El archivo generado, tal cual se escribe en disco. */
export function textoDelArchivo(ordenadas) {
  return (
    '// Generado por scripts/generar-catalogo-herramientas.mjs desde el OpenAPI\n' +
    '// de la app levantada y el AST de los controladores. NO editar a mano:\n' +
    '// la descripción en español y si la acción es reversible viven en\n' +
    '// `catalogo-curado.ts`, que es lo único que escribe una persona.\n\n' +
    'export interface OperacionDeLaApi {\n' +
    '  metodo: string;\n' +
    '  /** Tal como la publica el documento, con `{id}`. */\n' +
    '  ruta: string;\n' +
    '  resumen: string;\n' +
    '  /** El que exige `RequirePermission`. `null` = no exige ninguno. */\n' +
    '  permiso: string | null;\n' +
    '  /** El módulo dueño: apagado, la operación no existe para ese tenant. */\n' +
    '  modulo: string | null;\n' +
    '  /** Solo pide sesión, sin tenant ni permiso (`RequireAuth`). */\n' +
    '  soloSesion: boolean;\n' +
    '  /** JSON Schema de los argumentos, sacado de los decoradores del método. */\n' +
    '  argumentos: Record<string, unknown>;\n' +
    '}\n\n' +
    `export const OPERACIONES_DE_LA_API: Record<string, OperacionDeLaApi> = ${JSON.stringify(ordenadas, null, 2)};\n`
  );
}

// Solo cuando se corre a mano: `node scripts/generar-catalogo-herramientas.mjs openapi.json`
if (process.argv[1] && process.argv[1].endsWith('generar-catalogo-herramientas.mjs')) {
  const ordenadas = construirCatalogo(JSON.parse(readFileSync(process.argv[2], 'utf8')));
  writeFileSync(
    join(RAIZ, 'packages/modules/agents/application/catalogo.generated.ts'),
    textoDelArchivo(ordenadas),
  );
  console.log(`operaciones en el catálogo: ${Object.keys(ordenadas).length}`);
}
