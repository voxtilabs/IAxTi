import { readFileSync } from 'node:fs';

/**
 * El `plan_min` del manifiesto nombra un plan que de verdad vende el módulo
 * (#834).
 *
 * ## Qué estaba mal
 *
 * `plan_min` está en los diecinueve `module.yaml` y en `ModuleManifest`, y lo
 * lee **cero código**: el acceso por plan sale solo de la base
 * (`plan_limits.modules`, vía `modulosVendibles`/`modulosDelPlan`). O sea que
 * son dos declaraciones de lo mismo y la que está a la vista en el repo es la
 * inerte.
 *
 * Y ya divergió. Medido el 11-10: cuatro módulos que se venden desde un plan
 * de arriba dicen `plan_min: base` —`analytics` (se vende desde `equipo`),
 * `automations`, `integrations` y `knowledge` (desde `crece`)—. Quien lea
 * `analytics/module.yaml` concluye que analítica viene en el plan más barato.
 * No viene.
 *
 * ## Qué NO hace esta guarda, y por qué
 *
 * No convierte `plan_min` en la fuente de verdad. No puede: `updatePlan`
 * (platform) hace `UPDATE plan_limits SET …`, así que los planes se editan en
 * caliente y un campo estático del repo no puede quedar verdadero contra datos
 * que cambian. Lo que esto compara es `plan_min` contra el **seed**, que es el
 * plan por defecto declarado — las dos declaraciones del DEFECTO, en sincronía.
 *
 * Si `plan_min` debería desaparecer o convertirse en la fuente del seed es una
 * decisión y está en #834.
 *
 * ## La infraestructura no cuenta
 *
 * Un módulo se cobra por plan si ALGÚN plan lo vende; el resto —identity,
 * channels, whatsapp, notifications, platform, webchat, billing— es
 * infraestructura, no se vende por separado y no se apaga por plan (el
 * docstring de `modulosVendibles` lo dice así). Para ésos `plan_min: base`
 * significa «en todos los planes» y es correcto.
 *
 * ## El orden de los planes
 *
 * **No está declarado en ninguna parte del código.** Acá se toma el orden de
 * las filas del `INSERT INTO plan_limits` del seed, que está escrito de más
 * barato a más caro. Es una suposición y queda dicha: el día que el seed se
 * reordene o que un plan nuevo entre al medio, el orden hay que declararlo.
 */

export interface PlanSembrado {
  plan: string;
  modulos: string[];
}

/**
 * Los planes del seed, EN EL ORDEN DE LAS FILAS, con los módulos que venden.
 *
 * Se lee la migración y no la base: lo que se compara es el defecto declarado,
 * no lo que un SuperAdmin haya editado después.
 */
export function planesDelSeed(rutaDeLaMigracion: string): PlanSembrado[] {
  const sql = readFileSync(rutaDeLaMigracion, 'utf8');
  const insert = sql.indexOf('INSERT INTO plan_limits');
  if (insert === -1) {
    throw new Error(
      `no se encontró el INSERT de plan_limits en ${rutaDeLaMigracion}. Si la migración se ` +
        'renombró o el seed se movió, hay que actualizar esta guarda: sin el INSERT no mide nada.',
    );
  }
  const planes: PlanSembrado[] = [];
  // `('base', 1, 500, …, '["crm","conversations",…]')`
  const fila = /\(\s*'([a-z_]+)'[^)]*?'(\[[^\]]*\])'\s*\)/g;
  for (const m of sql.slice(insert).matchAll(fila)) {
    planes.push({ plan: m[1], modulos: JSON.parse(m[2]) as string[] });
  }
  return planes;
}

export interface PlanMinQueMiente {
  modulo: string;
  dice: string;
  deberia: string;
}

/**
 * Los módulos cuyo `plan_min` no nombra el plan más barato que los vende.
 *
 * Los que ningún plan vende quedan fuera: son infraestructura.
 */
export function planMinQueMiente(
  modulos: Array<{ id: string; planMin?: string }>,
  planes: PlanSembrado[],
): PlanMinQueMiente[] {
  const malos: PlanMinQueMiente[] = [];
  for (const m of modulos) {
    const primero = planes.find((p) => p.modulos.includes(m.id));
    if (!primero) continue;
    const dice = m.planMin ?? '(sin plan_min)';
    if (dice !== primero.plan) malos.push({ modulo: m.id, dice, deberia: primero.plan });
  }
  return malos;
}
