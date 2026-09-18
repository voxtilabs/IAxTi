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

/**
 * Y el espejo: lo que un módulo declara CONSUMIR tiene que tener un
 * consumidor de verdad.
 *
 * El test de arriba cuida un lado del contrato —lo declarado se publica— y
 * el otro no lo cuidaba nadie. Un `consumes` sin handler no falla: el evento
 * pasa por el despachador, no le corresponde a nadie, y el manifiesto sigue
 * diciendo que ese módulo reacciona. Quien lea el catálogo para saber qué
 * pasa cuando algo ocurre, va a creerle.
 *
 * Se busca el nombre del evento en el código del módulo que lo declara Y en
 * el de las apps, porque parte del cableado vive ahí: `contact.merged` tiene
 * su handler en el módulo `conversations` y el registro en el despachador de
 * `apps/workers`. Buscando solo dentro del módulo, este test lo daba por
 * huérfano — un falso positivo que me costó entender hasta que miré el
 * despachador.
 *
 * No prueba que el handler esté REGISTRADO —eso lo cuida cada módulo con su
 * propio test—, pero sí que el evento exista en algún lado: la diferencia
 * entre "está escrito en otro archivo" y "no está escrito".
 */
describe('los eventos que se declaran consumir tienen quien los consuma', () => {
  it('cada `consumes` del manifiesto aparece en el código de su módulo', () => {
    const modulesDir = findModulesDir();
    const huerfanos: string[] = [];

    for (const manifest of loadAllManifests(modulesDir)) {
      const consumidos = manifest.events?.consumes ?? [];
      if (consumidos.length === 0) continue;
      const raiz = join(modulesDir, '..', '..');
      const codigo = [join(modulesDir, manifest.module.id), join(raiz, 'apps')]
        .flatMap((d) => fuentes(d))
        .map((f) => readFileSync(f, 'utf8'))
        .join('\n');
      for (const evento of consumidos) {
        if (!codigo.includes(`'${evento}'`)) {
          huerfanos.push(`${evento} (lo declara ${manifest.module.id} y no lo maneja)`);
        }
      }
    }

    expect(
      huerfanos,
      `eventos declarados como consumidos sin consumidor:\n  ${huerfanos.join('\n  ')}\n` +
        'Escribe el consumidor, o sácalo del manifiesto: el catálogo es el contrato.',
    ).toEqual([]);
  });
});
