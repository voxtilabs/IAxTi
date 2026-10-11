import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fuenteLimpia } from './testing/fuente-limpia';

/**
 * Lo que un módulo IMPORTA de otro está declarado en su manifiesto (#821).
 *
 * ## Para qué sirve declararlo
 *
 * `ModuleRegistry.disable()` se niega a apagar un módulo del que otro ACTIVO
 * depende como `required` (SPEC §26 regla 4). Esa es toda la protección, y la
 * lee del manifiesto: una dependencia que el código ejerce y el manifiesto no
 * declara **no existe** para el registry.
 *
 * El caso medido: `webchat/application/webchat.ts` llamaba a
 * `receiveInboundForContact` y `autoAssignNew` de `conversations` sin ninguna
 * guarda, y su manifiesto no lo declaraba. `conversations` no es del núcleo,
 * así que el kill switch del SuperAdmin lo apagaba sin objeción — y las rutas
 * públicas del widget seguían escribiendo mensajes en una bandeja que el
 * equipo ya no podía abrir.
 *
 * ## El núcleo no cuenta
 *
 * `identity`, `organizations`, `authorization` y `audit` son inapagables
 * (`core: true`). Importarlos sin declararlos no deja ningún hueco, porque no
 * hay nada que el registry pudiera impedir. Y declararlos sin importarlos es
 * la convención del repo —trece de los diecinueve manifiestos lo hacen— así
 * que exigirlo en cualquiera de las dos direcciones serían trece entradas de
 * ruido, y una lista con trece entradas de ruido enseña a no mirar la lista.
 *
 * ## Y el espejo, que es más fino
 *
 * Una dependencia declarada como `required` y que el módulo no importa hace
 * que el registry se niegue a un apagado legítimo. Pero puede ser una
 * dependencia de SIGNIFICADO y no de código: `calendar` declara `crm` y no
 * importa su contrato, porque una cita sin contactos no quiere decir nada
 * aunque el código no lo llame. Esas van en la lista de abajo CON SU MOTIVO,
 * igual que las tablas cross-tenant de la cobertura de RLS.
 */

const NUCLEO = new Set(['identity', 'organizations', 'authorization', 'audit']);

/** `required` sin import, con el motivo por el que la dependencia es real. */
export const REQUERIDAS_SIN_IMPORT: Record<string, string> = {
  'calendar→crm':
    'Una cita cuelga de un contacto: el módulo guarda `contact_id` y la pantalla ' +
    'muestra de quién es la hora. Sin contactos la agenda no quiere decir nada, ' +
    'aunque el código de calendar no llame al contrato de crm.',
};

export interface DependenciaDelModulo {
  modulo: string;
  dependencia: string;
}

function fuentes(dir: string, acc: string[] = []): string[] {
  for (const entrada of readdirSync(dir)) {
    if (['node_modules', 'dist', 'tests', '.turbo', 'migrations'].includes(entrada)) continue;
    const ruta = join(dir, entrada);
    if (statSync(ruta).isDirectory()) fuentes(ruta, acc);
    else if (entrada.endsWith('.ts') && !entrada.endsWith('.d.ts')) acc.push(ruta);
  }
  return acc;
}

/** Los módulos que el código de `dir` importa, por el nombre de su paquete. */
export function modulosQueImporta(dir: string): Set<string> {
  const importados = new Set<string>();
  for (const archivo of fuentes(dir)) {
    const limpio = fuenteLimpia(readFileSync(archivo, 'utf8'));
    for (const m of limpio.matchAll(/from '@iaxti\/module-([a-z]+)'/g)) importados.add(m[1]);
  }
  return importados;
}

/** Importa y no declara: el registry no puede proteger lo que no está escrito. */
export function importaSinDeclarar(
  modulos: Array<{ id: string; dir: string; required: string[]; optional: string[] }>,
): DependenciaDelModulo[] {
  const huecos: DependenciaDelModulo[] = [];
  for (const m of modulos) {
    const declaradas = new Set([...m.required, ...m.optional]);
    for (const dep of modulosQueImporta(m.dir)) {
      if (dep === m.id || NUCLEO.has(dep) || declaradas.has(dep)) continue;
      huecos.push({ modulo: m.id, dependencia: dep });
    }
  }
  return huecos;
}

/** `required` sin import y sin motivo anotado: un apagado legítimo que se niega. */
export function requeridasSinImport(
  modulos: Array<{ id: string; dir: string; required: string[] }>,
): DependenciaDelModulo[] {
  const sobrantes: DependenciaDelModulo[] = [];
  for (const m of modulos) {
    const importadas = modulosQueImporta(m.dir);
    for (const dep of m.required) {
      if (NUCLEO.has(dep) || importadas.has(dep)) continue;
      if (`${m.id}→${dep}` in REQUERIDAS_SIN_IMPORT) continue;
      sobrantes.push({ modulo: m.id, dependencia: dep });
    }
  }
  return sobrantes;
}
