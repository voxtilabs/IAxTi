import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Embudos y etapas (#460).
 *
 * Renombrar el embudo, agregar una etapa, reordenarlas, cambiarles el
 * nombre y borrar una vacía: las cinco rutas existen desde #35 y no las
 * llamaba ninguna pantalla. El tablero dibujaba las etapas sembradas y no
 * había forma de tocarlas — un embudo que no es el del negocio se usa
 * igual, torcido, y después los números dicen cualquier cosa.
 */
const EMBUDOS = readFileSync(join(__dirname, '..', 'components', 'embudos.tsx'), 'utf8');
const MANIFIESTO = readFileSync(
  join(__dirname, '..', '..', '..', 'packages', 'modules', 'crm', 'module.yaml'),
  'utf8',
);

describe('administrar embudos', () => {
  it('usa las cinco rutas', () => {
    for (const trozo of [
      '`/pipelines/${p.id}`',
      '`/pipelines/${p.id}/etapas`',
      '`/pipelines/${p.id}/orden`',
      '`/etapas/${s.id}`',
    ]) {
      expect(EMBUDOS).toContain(trozo);
    }
    expect(EMBUDOS).toContain("method: 'DELETE'");
  });

  it('está en el menú, con el permiso que exige la API', () => {
    // `crm.pipelines.manage` y no `crm.deals.read`: quien solo mira el
    // tablero vería una pantalla que le va a responder 403.
    expect(MANIFIESTO).toContain('path: /ajustes/embudos, permission: crm.pipelines.manage');
  });

  it('ganada y perdida no se mueven ni se borran', () => {
    // El tablero las necesita para saber qué terminó bien y qué no.
    expect(EMBUDOS).toMatch(/s\.type === 'open' && \(\s*<>/);
  });

  it('el reorden manda el orden COMPLETO de las abiertas', () => {
    expect(EMBUDOS).toContain("abiertas = p.stages.filter((s) => s.type === 'open')");
    expect(EMBUDOS).toContain('stageIds: orden');
  });

  it('guardar sin cambiar el nombre no hace nada', () => {
    expect(EMBUDOS).toContain('(nombres[s.id] ?? s.name) === s.name');
  });

  it('el motivo del rechazo lo pone el servidor', () => {
    // Borrar una etapa CON oportunidades se rechaza allá a propósito:
    // moverlas es una decisión del negocio, y su explicación vive ahí.
    expect(EMBUDOS).toContain('setAviso((err as Error).message)');
  });
});
