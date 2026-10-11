import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Rutas que la documentación cita y que no existen (#817).
 *
 * ## Por qué
 *
 * Los documentos de este repo no son adorno: el runbook de producción es lo
 * que alguien sigue a las tres de la mañana, los dos baselines son lo que se
 * muestra cuando preguntan por cumplimiento, y las reglas de `.claude/` son
 * lo que lee quien llega. Una ruta citada que ya no existe convierte una
 * instrucción en un callejón, y nadie se entera hasta que la necesita.
 *
 * Y la noche del 10/10 dejó la razón de fondo: el peligro no es el documento
 * incompleto, es el documento que **afirma**. `SECURITY_BASELINE.md` daba
 * «Dependabot semanal» por hecho sin que existiera `.github/dependabot.yml`,
 * así que las dependencias envejecían sin aviso y el control estaba marcado
 * como cumplido — nadie iba a ir a mirar.
 *
 * Esta guarda no puede comprobar que una afirmación sea verdad. Sí puede
 * comprobar lo más barato y lo que se rompe solo: que el archivo que la
 * afirmación nombra esté ahí.
 *
 * ## Qué cuenta como ruta
 *
 * Solo lo que va entre comillas invertidas y empieza por una carpeta del
 * repo. Medido antes de elegir el criterio: 87 citas, 2 rotas. Con un
 * criterio más suelto —cualquier cosa con una barra— entraban nombres de
 * cabeceras HTTP, rutas de API y expresiones, y una guarda que grita de más
 * se apaga igual de rápido que una que no grita (#569).
 *
 * Se descartan los marcadores de posición (`<id>`, `$ARGUMENTS`) y lo que no
 * tiene forma de archivo ni de carpeta: un `packages/modules/<id>/migrations/`
 * es una plantilla, y el `docs/adr/0001` de «genera `docs/adr/0001` a `0015`»
 * es un rango de prefijos.
 */

const RAICES_DEL_REPO = /^(apps|packages|docs|scripts|infra|\.github|\.claude)\//;

/** `<id>`, `$ARGUMENTS`, globs: plantillas, no citas. */
const ES_PLANTILLA = /[ *<>$]/;

/**
 * Una cita es un ARCHIVO (con extensión) o una CARPETA (con barra al final).
 *
 * Sin esto, `docs/adr/0001` del SPEC entraba como ruta rota, y no lo es: la
 * frase dice «genera `docs/adr/0001` a `0015`», o sea un rango de prefijos.
 * Un falso positivo en una guarda nueva es el camino conocido a que se relaje
 * la expresión y después se borre el archivo.
 */
const ES_ARCHIVO_O_CARPETA = /\.[a-zA-Z0-9]{1,5}$|\/$/;

const NO_SE_MIRAN = new Set([
  'node_modules',
  '.git',
  // Worktrees de agentes: copias del repo, con sus propias copias de los
  // mismos documentos. Multiplicaban cada hallazgo por doce.
  'worktrees',
  'dist',
  '.next',
  'coverage',
]);

export interface RutaCitada {
  documento: string;
  linea: number;
  ruta: string;
}

function documentos(raiz: string, acc: string[] = []): string[] {
  for (const entrada of readdirSync(raiz)) {
    if (NO_SE_MIRAN.has(entrada)) continue;
    const ruta = join(raiz, entrada);
    if (statSync(ruta).isDirectory()) documentos(ruta, acc);
    else if (entrada.endsWith('.md')) acc.push(ruta);
  }
  return acc;
}

/** Las rutas del repo que un texto cita entre comillas invertidas. */
export function rutasCitadas(texto: string): Array<{ linea: number; ruta: string }> {
  const encontradas: Array<{ linea: number; ruta: string }> = [];
  texto.split('\n').forEach((linea, i) => {
    // Los trozos impares de partir por ` son los que estaban ENTRE comillas.
    const entreComillas = linea.split('`').filter((_, indice) => indice % 2 === 1);
    for (const trozo of entreComillas) {
      // `archivo.ts:42` cita una línea; lo que hay que comprobar es el archivo.
      const candidato = trozo.trim().replace(/[:,.)]+$/, '').split(':')[0];
      if (!RAICES_DEL_REPO.test(candidato) || ES_PLANTILLA.test(candidato)) continue;
      if (!ES_ARCHIVO_O_CARPETA.test(candidato)) continue;
      encontradas.push({ linea: i + 1, ruta: candidato });
    }
  });
  return encontradas;
}

/** Las citas de `raices` que no corresponden a nada en disco. */
export function rutasQueNoExisten(raices: string[], base: string): RutaCitada[] {
  const rotas: RutaCitada[] = [];
  for (const raiz of raices) {
    const completa = join(base, raiz);
    if (!existsSync(completa)) continue;
    const archivos = statSync(completa).isDirectory() ? documentos(completa) : [completa];
    for (const documento of archivos) {
      for (const { linea, ruta } of rutasCitadas(readFileSync(documento, 'utf8'))) {
        if (!existsSync(join(base, ruta))) {
          rotas.push({ documento: documento.slice(base.length + 1), linea, ruta });
        }
      }
    }
  }
  return rotas;
}
