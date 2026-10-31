import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fuenteLimpia } from '@iaxti/core/testing';

/**
 * A la API se le habla por `apiFetch`, no con `fetch` a mano (#1114).
 *
 * `apiFetch` pone `X-Tenant-Id`. Un `fetch` armado a mano lo pone si el que
 * lo escribe se acuerda, y el defecto que originó esta guarda es que en UN
 * MISMO archivo dos llamadas se acordaron y tres no.
 *
 * Lo que eso costó: la API contestaba `401 TENANT_REQUIRED` con un JSON
 * válido —así que `.json()` no fallaba—, el campo que se leía quedaba
 * `undefined`, y el componente lo interpretaba como «esta función no está
 * disponible» y devolvía `null`. La sección de avisos push llevaba desplegada
 * desde #78 sin dibujarse nunca, sin error en pantalla y sin nada en los
 * registros que dijera que algo faltaba.
 *
 * Por eso la guarda es de FUENTE y no de comportamiento: el síntoma es una
 * ausencia, y una ausencia no se puede afirmar pantalla por pantalla. Lo que
 * sí se puede afirmar es que nadie arma la URL a mano.
 */
const RAIZ = join(__dirname, '..');

/**
 * La única excepción, con su motivo.
 *
 * `GET /modules/catalogo` es el catálogo DEL DESPLIEGUE: es público, se pide
 * sin sesión y devuelve lo mismo para todos (`.claude/rules/modulos.md`).
 * Pasarlo por `apiFetch` exigiría una sesión y un negocio que en ese momento
 * pueden no existir todavía — es lo que dibuja la navegación.
 *
 * Esta lista no crece sin un motivo escrito acá. «Me quedaba más cómodo» no
 * es uno: lo cómodo fue exactamente lo que escondió una función entera.
 */
const PERMITIDAS: Record<string, string[]> = {
  'components/app-shell.tsx': ['/v1/modules/catalogo'],
};

function* fuentes(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '.next' || e.startsWith('.')) continue;
    const ruta = join(dir, e);
    if (statSync(ruta).isDirectory()) yield* fuentes(ruta);
    else if (e.endsWith('.tsx') || e.endsWith('.ts')) yield ruta;
  }
}

describe('a la API se le habla por apiFetch', () => {
  it('ningún componente arma `${config.apiUrl}/v1…` a mano', () => {
    const culpables: string[] = [];
    for (const carpeta of ['components', 'app']) {
      for (const archivo of fuentes(join(RAIZ, carpeta))) {
        const rel = archivo.slice(RAIZ.length + 1).replaceAll('\\', '/');
        const fuente = fuenteLimpia(readFileSync(archivo, 'utf8'));
        for (const m of fuente.matchAll(/apiUrl\}(\/v1[A-Za-z0-9/_-]*)/g)) {
          if (PERMITIDAS[rel]?.includes(m[1])) continue;
          culpables.push(`${rel} → ${m[1]}`);
        }
      }
    }
    expect(culpables).toEqual([]);
  });

  it('`apiFetch` sigue siendo quien pone el negocio', () => {
    // Si alguien le saca el header a `apiFetch`, la guarda de arriba deja de
    // significar algo: estaría exigiendo que todos pasen por una puerta que ya
    // no cierra.
    const api = fuenteLimpia(readFileSync(join(RAIZ, 'lib', 'api.ts'), 'utf8'));
    expect(api).toContain("'X-Tenant-Id': tenantId");
  });
});
