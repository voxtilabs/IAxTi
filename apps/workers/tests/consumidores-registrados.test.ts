import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Un consumidor escrito y no registrado es un evento que nadie escucha.
 *
 * No falla: el evento se publica, entra al outbox, el despachador no
 * encuentra a nadie interesado y sigue. Todo verde, y la función
 * sencillamente no ocurre — el aviso no llega, el paso del onboarding no
 * avanza, el intento no se cierra.
 *
 * La guarda de `packages/core/tests/eventos-declarados.test.ts` cubre que el
 * `consumes` del manifiesto tenga handler escrito, y dice con todas sus
 * letras que NO prueba que ese handler esté registrado. Este es ese pedazo.
 *
 * Acá y no en `core` a propósito: `apps/workers` sí depende de todos los
 * módulos, así que cuando uno agrega un consumidor la caché de turbo se
 * invalida sola. En `core` la guarda se saltaría sin que nadie se entere,
 * que es justo lo que pasó con el inventario de datos (#323).
 */
const RAIZ = join(__dirname, '..', '..', '..');
const MODULOS = join(RAIZ, 'packages', 'modules');

/** Los `xxxConsumers()` que cada módulo EXPORTA por su contrato. */
function consumidoresExportados(): Array<{ modulo: string; nombre: string }> {
  const salida: Array<{ modulo: string; nombre: string }> = [];
  for (const modulo of readdirSync(MODULOS)) {
    const contrato = join(MODULOS, modulo, 'contract.ts');
    if (!existsSync(contrato)) continue;
    const texto = readFileSync(contrato, 'utf8');
    for (const m of texto.matchAll(/\b([a-zA-Z]+Consumers)\b/g)) {
      if (!salida.some((x) => x.nombre === m[1])) salida.push({ modulo, nombre: m[1] });
    }
  }
  return salida;
}

describe('todo consumidor exportado está registrado en el despachador', () => {
  const main = readFileSync(join(__dirname, '..', 'src', 'main.ts'), 'utf8');

  it('ninguno se queda escrito sin que nadie lo escuche', () => {
    const exportados = consumidoresExportados();
    // Si esto da 0, el test dejó de mirar lo que cree mirar.
    expect(exportados.length).toBeGreaterThanOrEqual(8);

    const sinRegistrar = exportados.filter((c) => !main.includes(`...${c.nombre}(`));
    expect(
      sinRegistrar,
      'Estos consumidores existen y NO están en el despachador de apps/workers/src/main.ts:\n' +
        sinRegistrar.map((c) => `  ${c.nombre} (módulo ${c.modulo})`).join('\n') +
        '\nSu evento se publica, no lo escucha nadie, y todo sigue en verde.',
    ).toEqual([]);
  });

  it('y el despachador no registra consumidores que ya no existen', () => {
    // Al revés: un `...xxxConsumers()` que quedó de un módulo borrado no
    // compila, pero uno renombrado a mano sí puede quedar apuntando a nada.
    const registrados = [...main.matchAll(/\.\.\.([a-zA-Z]+Consumers)\(/g)].map((m) => m[1]);
    expect(registrados.length).toBeGreaterThanOrEqual(8);
    const nombres = new Set(consumidoresExportados().map((c) => c.nombre));
    // `realtimeConsumers` vive en el propio worker, no en un módulo.
    const huerfanos = registrados.filter((r) => !nombres.has(r) && r !== 'realtimeConsumers');
    expect(huerfanos).toEqual([]);
  });
});
