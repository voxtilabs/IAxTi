import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Las corridas del asistente, una por una (#460).
 *
 * `GET /agents/executions` existe desde #49 y no la llamaba nadie. El
 * agregado por día dice CUÁNTO; cuando algo sale caro o lento, lo que hace
 * falta es cuál — y el trace, que es con lo que se busca en Grafana.
 */
const CONSUMO = readFileSync(join(__dirname, '..', 'components', 'consumo-ia.tsx'), 'utf8');

describe('corridas del asistente', () => {
  it('llama a la ruta que ya guardaba todo', () => {
    expect(CONSUMO).toContain("'/agents/executions'");
  });

  it('se piden al abrir el detalle, no al cargar la pantalla', () => {
    // Es una lista larga que casi nunca se mira: pedirla siempre es un
    // viaje de más en cada visita a Ajustes → IA.
    expect(CONSUMO).toContain('if (corridas === null) void cargarCorridas();');
  });

  it('una corrida que falló se ve entre las buenas', () => {
    // Cuesta igual, y es lo que explica un costo que no calza con lo que
    // se ve en la bandeja.
    expect(CONSUMO).toContain("c.status !== 'ok'");
  });

  it('lo que no se midió se muestra como «—», no como cero', () => {
    expect(CONSUMO).toContain("c.latencyMs === null ? '—'");
    expect(CONSUMO).toContain("c.costUsd === null ? '—'");
  });
});
