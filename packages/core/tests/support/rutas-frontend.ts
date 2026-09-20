import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript';

const VARIABLE = '«valor»';
export interface RutaLlamada { archivo: string; linea: number; ruta: string }
export interface InventarioRutas { declaradas: string[]; llamadas: RutaLlamada[] }

function archivos(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (/^(node_modules|dist|tests|e2e|\.next)$/.test(e.name)) return [];
    const path = join(dir, e.name);
    return e.isDirectory() ? archivos(path) : /(?<!\.d)\.tsx?$/.test(path) ? [path] : [];
  });
}

/** Solo sintaxis y símbolos locales: no importa React/Nest ni ejecuta las apps. */
export function inventario(fuentes: Record<string, string>): InventarioRutas {
  const host = ts.createCompilerHost({});
  host.getSourceFile = (nombre) => {
    const key = fuentes[nombre] === undefined ? relative(process.cwd(), nombre) : nombre;
    return fuentes[key] === undefined ? undefined : ts.createSourceFile(key, fuentes[key], ts.ScriptTarget.Latest, true,
      key.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  };
  host.resolveModuleNames = (names, containing) => names.map((name) => {
    if (!name.startsWith('.')) return undefined;
    const base = relative(process.cwd(), join(dirname(containing), name));
    const path = [base + '.ts', base + '.tsx', join(base, 'index.ts')].find((p) => fuentes[p] !== undefined);
    return path ? { resolvedFileName: path, isExternalLibraryImport: false } : undefined;
  });
  const program = ts.createProgram(Object.keys(fuentes), { noLib: true, types: [], jsx: ts.JsxEmit.Preserve }, host);
  const checker = program.getTypeChecker();
  const files = program.getSourceFiles();
  const calls: ts.CallExpression[] = [];
  const declaradas: string[] = [];
  function recorrer(node: ts.Node, visitar: (n: ts.Node) => void) {
    visitar(node);
    ts.forEachChild(node, (n) => recorrer(n, visitar));
  }
  for (const file of files) recorrer(file, (node) => {
    if (ts.isCallExpression(node)) calls.push(node);
  });
  const simbolo = (node: ts.Node) => checker.getSymbolAtLocation(node);
  const producto = (a: string[], b: string[]) => [...new Set(a.flatMap((x) => b.map((y) => x + y)))];

  function valores(node: ts.Node | undefined, vistos = new Set<ts.Node>()): string[] {
    if (!node || vistos.has(node)) return [VARIABLE];
    const siguientes = new Set(vistos).add(node);
    const leer = (n: ts.Node | undefined) => valores(n, siguientes);
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) {
      return leer(node.expression);
    }
    if (ts.isConditionalExpression(node)) return [...leer(node.whenTrue), ...leer(node.whenFalse)];
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return producto(leer(node.left), leer(node.right));
    }
    if (ts.isTemplateExpression(node)) {
      return node.templateSpans.reduce((partes, span) =>
        producto(partes, leer(span.expression)).map((p) => p + span.literal.text), [node.head.text]);
    }
    if (ts.isIdentifier(node)) {
      const decl = simbolo(node)?.valueDeclaration;
      if (decl && ts.isVariableDeclaration(decl)) return leer(decl.initializer);
      if (decl && ts.isParameter(decl)) {
        const fn = decl.parent;
        if (ts.isFunctionDeclaration(fn) || ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
          const parent = ts.isCallExpression(fn.parent) && fn.parent.expression.getText() === 'useCallback'
            ? fn.parent.parent : fn.parent;
          const nombre = fn.name ?? (ts.isVariableDeclaration(parent) ? parent.name : undefined);
          const target = nombre && simbolo(nombre);
          const indice = fn.parameters.indexOf(decl);
          const usos = target ? calls.filter((c) => simbolo(c.expression) === target) : [];
          if (usos.length) return [...new Set(usos.flatMap((c) => leer(c.arguments[indice])))];
        }
      }
    }
    const tipo = checker.getTypeAtLocation(node);
    const opciones = tipo.isUnion() ? tipo.types : [tipo];
    if (opciones.every((t) => t.isStringLiteral())) return opciones.map((t) => (t as ts.StringLiteralType).value);
    return [VARIABLE];
  }

  const decoradores = (node: ts.Node) => ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : [];
  function rutaDecorador(node: ts.Decorator, nombre: RegExp): string[] | undefined {
    if (!ts.isCallExpression(node.expression) || !nombre.test(node.expression.expression.getText())) return;
    const arg = node.expression.arguments[0];
    if (!arg) return [''];
    return ts.isArrayLiteralExpression(arg) ? arg.elements.flatMap((e) => valores(e)) : valores(arg);
  }
  for (const file of files.filter((f) => f.fileName.includes('/api/'))) recorrer(file, (node) => {
    if (!ts.isClassDeclaration(node)) return;
    const prefijos = decoradores(node).flatMap((d) => rutaDecorador(d, /^Controller$/) ?? []);
    for (const member of node.members) {
      const rutas = decoradores(member).flatMap((d) => rutaDecorador(d, /^(Get|Post|Put|Patch|Delete|Head|Options|All)$/) ?? []);
      for (const prefijo of prefijos) for (const ruta of rutas) {
        declaradas.push('/' + [prefijo, ruta].map((s) => s.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/'));
      }
    }
  });

  const llamadas: RutaLlamada[] = [];
  for (const call of calls.filter((c) => !c.getSourceFile().fileName.includes('/api/'))) {
    const nombre = call.expression.getText();
    const api = nombre === 'apiFetch';
    if (!api && nombre !== 'fetch') continue;
    // La implementación central de apiFetch se cubre en sus sitios de uso.
    if (!api && /\/lib\/api\.ts$/.test(call.getSourceFile().fileName)) continue;
    for (const valor of valores(call.arguments[api ? 3 : 0])) {
      const version = valor.indexOf('/v1');
      if (!api && (version < 0 || !/^\/v1(?:\/|«|$)/.test(valor.slice(version)))) continue;
      const ruta = (api ? valor : valor.slice(version + 3)).split(/[?#]/)[0].replace(/\/$/, '') || '/';
      llamadas.push({
        archivo: call.getSourceFile().fileName,
        linea: call.getSourceFile().getLineAndCharacterOfPosition(call.getStart()).line + 1,
        ruta,
      });
    }
  }
  return { declaradas: [...new Set(declaradas)], llamadas };
}

/** Un valor dinámico solo puede ocupar un parámetro del servidor, no inventar un sufijo. */
export function rutasInexistentes(datos: InventarioRutas): RutaLlamada[] {
  return datos.llamadas.filter(({ ruta }) => !datos.declaradas.some((declarada) => {
    const cliente = ruta.split('/');
    const servidor = declarada.split('/');
    return cliente.length === servidor.length && servidor.every((parte, i) =>
      parte.startsWith(':') ? Boolean(cliente[i]) && !cliente[i].includes(VARIABLE + VARIABLE)
        : parte === cliente[i]);
  }));
}

export function inventarioDelRepositorio(raiz: string): InventarioRutas {
  const paths = ['apps/web', 'apps/admin', 'apps/api/src'].flatMap((dir) => archivos(join(raiz, dir)));
  return inventario(Object.fromEntries(paths.map((path) => [relative(raiz, path), readFileSync(path, 'utf8')])));
}
