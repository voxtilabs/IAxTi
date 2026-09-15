import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { findModulesDir, loadAllManifests } from '../src/manifest';

/**
 * Cada módulo declara en su `module.yaml` los eventos que PUBLICA. Nada
 * comprobaba que alguien los publicara de verdad.
 *
 * Un evento declarado y nunca emitido no falla: simplemente no pasa nada.
 * Quien escriba un consumidor confiando en el manifiesto se queda esperando
 * para siempre, y el manifiesto —que es el contrato entre módulos— deja de
 * ser creíble.
 *
 * Los que todavía no existen van en la lista de abajo CON SU MOTIVO, igual
 * que las tablas cross-tenant de la cobertura de RLS.
 */
const SIN_PRODUCTOR: Record<string, string> = {
  'template.approved':
    'Las plantillas con aprobación de Meta son #44; el evento espera a que exista el flujo.',
  'template.rejected': 'Ídem #44.',
  'user.registered':
    'El registro vive en Supabase Auth; el evento llega cuando conectemos su webhook (#7).',
  'user.login_failed':
    'Hoy el intento fallido se cuenta en Redis desde el guard (#71); el evento llega con el webhook de Supabase (#7).',
};

function fuentes(dir: string, acc: string[] = []): string[] {
  for (const entrada of readdirSync(dir)) {
    if (entrada === 'node_modules' || entrada === 'dist' || entrada === '.next') continue;
    const ruta = join(dir, entrada);
    const st = statSync(ruta);
    if (st.isDirectory()) {
      if (entrada === 'tests') continue; // un test no cuenta como productor
      fuentes(ruta, acc);
    } else if (entrada.endsWith('.ts') && !entrada.endsWith('.d.ts') && !entrada.endsWith('.test.ts')) {
      acc.push(ruta);
    }
  }
  return acc;
}

describe('los eventos declarados tienen quien los publique', () => {
  it('cada `publishes` del manifiesto aparece en código de producción', () => {
    const modulesDir = findModulesDir();
    const raiz = join(modulesDir, '..', '..');
    const codigo = [join(raiz, 'packages'), join(raiz, 'apps')]
      .flatMap((d) => fuentes(d))
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');

    const huerfanos: string[] = [];
    for (const manifest of loadAllManifests(modulesDir)) {
      for (const evento of manifest.events?.publishes ?? []) {
        if (evento in SIN_PRODUCTOR) continue;
        if (!codigo.includes(`'${evento}'`)) {
          huerfanos.push(`${evento} (declarado por ${manifest.module.id})`);
        }
      }
    }
    expect(
      huerfanos,
      `eventos declarados que no publica nadie:\n  ${huerfanos.join('\n  ')}\n` +
        'Publícalo donde corresponda, o anótalo en SIN_PRODUCTOR con su motivo.',
    ).toEqual([]);
  });

  it('la lista de excepciones no junta polvo: todas siguen declaradas', () => {
    const declarados = new Set(
      loadAllManifests(findModulesDir()).flatMap((m) => m.events?.publishes ?? []),
    );
    const sobrantes = Object.keys(SIN_PRODUCTOR).filter((e) => !declarados.has(e));
    expect(sobrantes, `excepciones de eventos que ya nadie declara: ${sobrantes.join(', ')}`).toEqual([]);
  });
});
