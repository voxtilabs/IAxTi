import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * El proceso de agentes consume su cola (#443).
 *
 * Estuvo desplegado desde el primer día contestando solo `/health`: 28
 * líneas y un comentario que decía «el procesamiento real llega con el
 * #47» — issue que se cerró hace rato. El trabajo de IA corría dentro de
 * workers, en la misma cola de eventos que el camino de entrada y de salida
 * de mensajes, y nada lo decía: el despliegue insinuaba una separación que
 * no existía.
 *
 * Esto mira el CABLEADO, que es lo que falló: la lógica del copiloto tenía
 * sus tests y estaba bien.
 */
const AGENTS = readFileSync(join(__dirname, '..', 'src', 'main.ts'), 'utf8');
const WORKERS = readFileSync(join(__dirname, '..', '..', 'workers', 'src', 'main.ts'), 'utf8');

describe('quién consume la cola agents', () => {
  it('el proceso de agentes la consume', () => {
    expect(AGENTS).toMatch(/createModuleWorker\(\s*'agents'/);
    expect(AGENTS).toContain('processSuggest');
  });

  it('el de workers ya NO la consume, pero sigue encolando', () => {
    // El productor se queda donde está: quien encola es el camino de
    // entrada. Si esto se invierte, la separación se pierde sin que nada
    // falle — que es exactamente lo que pasó durante meses.
    expect(WORKERS).not.toMatch(/createModuleWorker\(\s*'agents'/);
    expect(WORKERS).toMatch(/agentsQueue[\s\S]{0,200}'suggest'/);
  });

  it('no arranca a medias: sin base o sin Redis lo dice y no finge', () => {
    // `/ready` respondía como «consumidor listo» sin consumir nada. Ahora
    // `consumersStarted` es lo que decide, igual que en workers.
    expect(AGENTS).toContain('consumersStarted');
    expect(AGENTS).toMatch(/sin DATABASE_URL/);
    expect(AGENTS).toMatch(/sin REDIS_URL/);
  });

  it('exige el rol que respeta RLS, como los otros procesos', () => {
    // Un proceso que se conecta con un rol que se salta las políticas ve
    // los datos de todos los negocios. Los otros dos ya lo comprobaban.
    expect(AGENTS).toContain('exigeRolQueRespetaRls');
  });
});
