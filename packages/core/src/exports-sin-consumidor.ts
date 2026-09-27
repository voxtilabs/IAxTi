import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Qué exporta cada módulo por su puerta pública, y quién lo usa (#664).
 *
 * `.claude/rules/arquitectura.md` dice que un módulo entra a otro SOLO por su
 * `contract.ts`. Esa regla vale porque el contrato es chico y deliberado: se
 * mira y se entiende qué ofrece el módulo. Medido el 27/09, de 858 exports **el
 * 49 % no lo usaba nadie fuera de su módulo** — así que «pasa por el contrato»
 * había dejado de ser una decisión para ser un trámite: se exporta todo por si
 * acaso.
 *
 * Y es el terreno donde crecen los defectos de esa semana. `presignPutUrl` vivía
 * así —exportado, probado, con CERO llamadores— mientras las tres puertas que
 * firmaban subidas usaban la versión insegura. Nadie lo notó porque nada lo
 * señalaba.
 *
 * Esto NO mide calidad ni pide cero. Mide una sola cosa comprobable: si algo que
 * el módulo publica tiene al menos un consumidor.
 */

const IGNORADOS = new Set(['node_modules', 'dist', '.next', '.claude', '.git', 'coverage']);

function fuentes(dir: string, acc: string[] = []): string[] {
  for (const entrada of readdirSync(dir)) {
    if (IGNORADOS.has(entrada)) continue;
    const ruta = join(dir, entrada);
    if (statSync(ruta).isDirectory()) fuentes(ruta, acc);
    else if (/\.tsx?$/.test(entrada)) acc.push(ruta);
  }
  return acc;
}

/**
 * Sin comentarios antes de buscar nombres.
 *
 * Los comentarios de este repo nombran funciones todo el tiempo —explican por
 * qué algo NO se usa, justamente— y ya hicieron pasar por verde a cuatro guardas
 * distintas. Se quitan primero, siempre.
 */
function sinComentarios(codigo: string): string {
  return codigo
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
}

/**
 * Los VALORES que publica un contrato: funciones, constantes y clases.
 *
 * Los tipos quedan fuera a propósito. Un módulo los expone para que quien
 * consume pueda nombrar lo que recibe, y que no aparezcan importados
 * explícitamente es normal —TypeScript los infiere—. Pedirles consumidor daría
 * cientos de falsos positivos y enseñaría a ignorar la guarda.
 *
 * `MODULE_ID` también queda fuera: lo exige la convención de módulos, no un
 * consumidor.
 */
export function valoresQuePublica(contrato: string): string[] {
  const texto = sinComentarios(readFileSync(contrato, 'utf8'));
  const nombres = new Set<string>();

  for (const m of texto.matchAll(/export\s*\{([^}]+)\}/g)) {
    if (/export\s*type\s*\{/.test(m[0])) continue;
    for (const parte of m[1].split(',')) {
      if (/^\s*type\s/.test(parte)) continue;
      const nombre = parte.trim().split(/\s+as\s+/).pop()?.trim();
      if (nombre && /^[A-Za-z_]\w*$/.test(nombre)) nombres.add(nombre);
    }
  }
  for (const m of texto.matchAll(/export\s+(?:const|function|async function|class)\s+(\w+)/g)) {
    nombres.add(m[1]);
  }
  nombres.delete('MODULE_ID');
  return [...nombres];
}

/** `packages/modules/<id>/contract.ts` → `@iaxti/module-<id>`. */
function paqueteDe(contrato: string): string {
  return `@iaxti/module-${dirname(contrato).split('/').pop()}`;
}

/**
 * Los que nadie importa desde fuera de su módulo, como `modulo/nombre`.
 *
 * «Desde fuera» es la clave: que un módulo use lo suyo no dice nada sobre si el
 * contrato hacía falta. Y se mira DENTRO de la sentencia `import ... from
 * '@iaxti/module-x'`, no en todo el archivo: un nombre suelto en cualquier parte
 * del código daría por usado algo que solo se menciona.
 */
export function exportsSinConsumidor(raices: string[]): string[] {
  const archivos = raices.flatMap((r) => fuentes(r));
  const codigo = new Map(archivos.map((f) => [f, sinComentarios(readFileSync(f, 'utf8'))]));
  const contratos = archivos.filter((f) => f.endsWith('contract.ts'));

  const huerfanos: string[] = [];
  for (const contrato of contratos) {
    const carpeta = `${dirname(contrato)}/`;
    const modulo = dirname(contrato).split('/').pop()!;
    const paquete = paqueteDe(contrato);
    const importa = new RegExp(`import[^;]*?from '${paquete}'`, 'g');

    const afuera = archivos.filter((f) => !f.startsWith(carpeta) && codigo.get(f)!.includes(paquete));
    const usados = new Set<string>();
    for (const f of afuera) {
      for (const sentencia of codigo.get(f)!.matchAll(importa)) {
        for (const nombre of valoresQuePublica(contrato)) {
          if (new RegExp(`\\b${nombre}\\b`).test(sentencia[0])) usados.add(nombre);
        }
      }
    }
    for (const nombre of valoresQuePublica(contrato)) {
      if (!usados.has(nombre)) huerfanos.push(`${modulo}/${nombre}`);
    }
  }
  return huerfanos.sort();
}
