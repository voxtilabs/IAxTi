import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A cuántos alcanza un filtro, antes de crear nada (#460).
 *
 * `POST /campanas/segmentos/vista-previa` existe desde #64 y no la
 * llamaba nadie: la otra vista previa necesita una campaña ya creada, así
 * que para saber si el filtro servía había que crear un borrador, mirarlo
 * y borrarlo.
 */
const CAMPANAS = readFileSync(join(__dirname, '..', 'components', 'campanas.tsx'), 'utf8');
const SDK = readFileSync(
  join(__dirname, '..', '..', '..', 'packages', 'sdk', 'src', 'campaigns.ts'),
  'utf8',
);
const RUTAS = readFileSync(
  join(__dirname, '..', '..', '..', 'packages', 'sdk', 'src', 'campaign-routes.generated.ts'),
  'utf8',
);

describe('alcance del segmento', () => {
  it('el SDK expone la operación', () => {
    expect(SDK).toContain("call<CampaignPreview>('CampanasController_vistaPrevia'");
    expect(RUTAS).toContain('/v1/campanas/segmentos/vista-previa');
  });

  it('se cuenta desde el formulario, sin campaña de por medio', () => {
    expect(CAMPANAS).toContain('cliente!.previewSegment(filtros)');
    expect(CAMPANAS).toContain('Ver a cuántos alcanza');
  });

  it('tocar un filtro borra el número mostrado', () => {
    // Un número que ya no corresponde a lo que está en pantalla es peor
    // que ninguno: se lee como el de ahora.
    expect(CAMPANAS).toMatch(/const setFiltros[\s\S]{0,160}setAlcance\(null\)/);
  });

  it('cero destinatarios se dice, no se deja pasar callado', () => {
    // Una campaña a cero no falla: se manda y no le llega a nadie.
    expect(CAMPANAS).toContain('alcance?.total === 0');
  });
});
