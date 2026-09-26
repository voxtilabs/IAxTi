import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Toda clave de `tenants.settings` que el código LEE tiene quien la escriba (#535).
 *
 * `updateTenantSettings` tenía exactamente dos llamadores en todo el producto
 * —los ajustes de bandeja y los de agenda—, más dos escrituras SQL directas.
 * Cualquier otra clave que el código leyera de `settings` era, por construcción,
 * una clave que nadie podía escribir. Eran cuatro:
 *
 *  - `pagos.maxLinkClpUser`: el tope del vendedor. Quedaba en null siempre, así
 *    que cualquier USER emitía un link por el monto que quisiera mientras la
 *    matriz §23 le prometía al dueño que «hasta tope» lo protege.
 *  - `pagos.paidStageName`: la oportunidad nunca se movía sola a «Pagado».
 *  - `ia`: el resguardo de ADR-0025 §7 —un cliente que exige un solo proveedor—
 *    solo se podía aplicar con un UPDATE a mano en producción.
 *  - `billing.iaAmpliacionClp`: una línea de factura que nunca se cobra.
 *
 * Ninguna fallaba. La lectura devolvía `undefined` y el código seguía con su
 * defecto, que en tres de los cuatro casos era «sin límite» o «no hacer nada».
 *
 * Los tests que escribían estas claves con SQL crudo son parte del problema:
 * escribir con SQL lo que el producto no puede escribir es cómo las cuatro
 * pasaron desapercibidas. Por eso este escáner IGNORA los tests.
 */
const RAIZ = join(__dirname, '..', '..', '..');

function fuentes(dir: string, acc: string[] = []): string[] {
  for (const entrada of readdirSync(dir)) {
    if (['node_modules', 'dist', '.next', '.turbo', 'tests'].includes(entrada)) continue;
    const ruta = join(dir, entrada);
    if (statSync(ruta).isDirectory()) fuentes(ruta, acc);
    else if (ruta.endsWith('.ts')) acc.push(ruta);
  }
  return acc;
}

const ARCHIVOS = [
  ...fuentes(join(RAIZ, 'apps/api/src')),
  ...fuentes(join(RAIZ, 'apps/workers/src')),
  ...fuentes(join(RAIZ, 'apps/agents/src')),
  ...fuentes(join(RAIZ, 'packages/modules')),
].map((f) => ({
  ruta: f.slice(RAIZ.length + 1),
  // Sin comentarios: un comentario que EXPLICA una clave no la lee ni la
  // escribe. Me costó cinco vueltas aprenderlo escribiendo estas guardas.
  texto: readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''),
}));

/**
 * Las claves de PRIMER NIVEL que alguien lee de los settings del tenant.
 *
 * Solo el patrón con el que el código las lee de verdad:
 *
 *     const settings = (await getTenantSettings(c, tid)) as { pagos?: {…} };
 *
 * Y contando llaves, no con un regex de una línea: el cast va casi siempre
 * partido en varias. La primera versión de esta guarda usaba `settings\.X` a
 * secas y traía las claves ANIDADAS —`silencio`, `horario`, `tasks`,
 * `economico`— como si fueran de primer nivel, y hasta un `controller` de otro
 * objeto que se llamaba igual. Diez falsos positivos: una guarda que grita de
 * más se apaga igual de rápido que una que no grita.
 */
function leidas(): Set<string> {
  const salida = new Set<string>();
  for (const { texto } of ARCHIVOS) {
    let desde = 0;
    for (;;) {
      const i = texto.indexOf('getTenantSettings(', desde);
      if (i === -1) break;
      desde = i + 1;
      const as = texto.indexOf(' as {', i);
      // El cast tiene que venir cerca: más allá hay otra sentencia.
      if (as === -1 || as - i > 200) continue;
      let profundidad = 0;
      let cuerpo = '';
      for (let j = as + 4; j < texto.length; j++) {
        const ch = texto[j];
        if (ch === '{') profundidad++;
        else if (ch === '}') {
          profundidad--;
          if (profundidad === 0) break;
        }
        // Solo lo que está al primer nivel del cast.
        if (profundidad === 1) cuerpo += ch;
      }
      for (const m of cuerpo.matchAll(/([a-z][a-zA-Z_]*)\s*\??\s*:/g)) salida.add(m[1]);
    }
    /**
     * Los lectores del dominio: `iaSettings`, `bandejaSettings` y compañía
     * reciben el objeto ENTERO y sacan su clave de primer nivel así:
     *
     *     const raw = (settings?.ia ?? {}) as Partial<{…}>;
     *
     * Eso es una lectura de primer nivel igual que un cast, y es donde viven
     * `ia`, `bandeja` y las de cierre. Lo que va DENTRO del `Partial<{…}>` son
     * claves anidadas y no se cuentan: por eso se mira solo la izquierda.
     */
    for (const m of texto.matchAll(/\(\s*settings\??\.([a-z][a-zA-Z_]*)\s*\?\?/g)) {
      salida.add(m[1]);
    }
    // Y las que se leen del jsonb por SQL: `settings -> 'retencion'`.
    for (const m of texto.matchAll(/settings\s*->>?\s*'([a-z][a-zA-Z_]*)'/g)) salida.add(m[1]);
  }
  return salida;
}

/** Las claves que alguien ESCRIBE, por `updateTenantSettings` o por SQL. */
function escritas(): Set<string> {
  const salida = new Set<string>();
  for (const { texto } of ARCHIVOS) {
    // `updateTenantSettings(c, id, { pagos, bandeja: ... })`
    for (const m of texto.matchAll(/updateTenantSettings\([^{]*\{([^}]*)\}/g)) {
      for (const k of m[1].matchAll(/([a-z][a-zA-Z_]*)\s*[:,}]/g)) salida.add(k[1]);
      for (const k of m[1].matchAll(/\b([a-z][a-zA-Z_]*)\s*$/gm)) salida.add(k[1]);
    }
    // SQL crudo: `jsonb_set(..., '{api}', ...)` o `'{retencion,monthsOverride}'`
    for (const m of texto.matchAll(/'\{([a-z][a-zA-Z_]*)[,}]/g)) salida.add(m[1]);
  }
  return salida;
}

/** Lo que se lee y no se escribe, con su motivo. Vacío es el objetivo. */
const SIN_ESCRITOR: Record<string, string> = {
  // `ia` salió de esta lista en #536: `PUT /agents/ajustes` escribe
  // `soloProveedor` y `redactPII`. Las otras dos claves de `ia` —`tasks` y
  // `economico`— siguen sin pantalla A PROPÓSITO: son perillas de quien conoce
  // los modelos, y ADR-0025 puso al Agente General como vía de configuración
  // justamente para no llenar la interfaz de cosas que un dueño de pyme no
  // puede evaluar. Se respetan si están escritas; lo que no hay es pantalla.
  billing:
    'Dentro vive `iaAmpliacionClp`, la ampliación de cuota de IA contratada: la línea de ' +
    'factura «Ampliación de asistencias de IA» está lista en pricing.ts y la clave no se ' +
    'puede escribir, así que nunca aparece en ninguna factura (#536). Va desde SuperAdmin, ' +
    'no desde el negocio: es un cargo contratado.',
};

describe('los ajustes del tenant tienen quien los escriba (#535)', () => {
  const lee = leidas();
  const escribe = escritas();

  it('el escáner encuentra lecturas y escrituras', () => {
    expect(lee.size, 'ninguna lectura: el escáner se rompió').toBeGreaterThan(3);
    expect(escribe.size, 'ninguna escritura: el escáner se rompió').toBeGreaterThan(3);
  });

  it('el escáner ve la clave que acabamos de cablear', () => {
    // Sin esto, «cero huérfanas» y «el escáner no mira donde debe» se ven igual.
    expect(lee.has('pagos'), 'no ve la lectura de settings.pagos').toBe(true);
    expect(escribe.has('pagos'), 'no ve la escritura de settings.pagos').toBe(true);
  });

  it('ninguna clave se lee sin que alguien pueda escribirla', () => {
    const huerfanas = [...lee]
      .filter((k) => !escribe.has(k))
      .filter((k) => !(k in SIN_ESCRITOR))
      .sort();
    expect(
      huerfanas,
      'Estas claves se LEEN de los ajustes del tenant y ninguna ruta las escribe. La ' +
        'lectura devuelve undefined y el código sigue con su defecto, sin que falle ' +
        'nada:\n  ' + huerfanas.join('\n  ') +
        '\nCablea su ruta, o agrégala a SIN_ESCRITOR con su issue.',
    ).toEqual([]);
  });

  it('SIN_ESCRITOR no junta polvo: nada que ya tenga escritor', () => {
    const yaTienen = Object.keys(SIN_ESCRITOR).filter((k) => escribe.has(k));
    expect(yaTienen, 'Sácalas de SIN_ESCRITOR: ya se pueden escribir').toEqual([]);
  });
});
