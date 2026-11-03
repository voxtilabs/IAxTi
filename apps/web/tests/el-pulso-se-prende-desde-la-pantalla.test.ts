import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fuenteLimpia } from '@iaxti/core/testing';

/**
 * Las perillas de la pantalla y lo que el motor respeta son la MISMA lista
 * (#1230).
 *
 * Guarda de fuente y no de comportamiento porque la pregunta es «¿está
 * escrito?»: que cada llave que la pantalla ofrece tocar la lea alguien del
 * otro lado, y que los números que la pantalla PROPONE sean los que el motor
 * usa cuando el negocio no los escribió.
 *
 * El defecto que vigila no se ve usando el producto: una perilla que escribe
 * una llave que nadie lee se guarda bien, vuelve bien al recargar, y no hace
 * absolutamente nada. Es peor que no tenerla — el negocio cree que configuró
 * algo. Y el revés es igual de silencioso: `configDelPulso` propone 40 minutos
 * y 6 mensajes por persona cuando faltan; si la pantalla propusiera otros, el
 * dueño leería un ritmo y correría otro.
 */
const PANTALLA_RUTA = join(__dirname, '..', 'components', 'modo-autonomo.tsx');
const MODULO = join(__dirname, '..', '..', '..', 'packages', 'modules', 'agents', 'application');

const PANTALLA = fuenteLimpia(readFileSync(PANTALLA_RUTA, 'utf8'));
const GUARDRAILS = fuenteLimpia(readFileSync(join(MODULO, 'autonomous.ts'), 'utf8'));
const PULSO = fuenteLimpia(readFileSync(join(MODULO, 'pulso.ts'), 'utf8'));
const MOTOR = `${GUARDRAILS}\n${PULSO}`;

/**
 * Las llaves que la pantalla declara poder escribir.
 *
 * Salen de la interfaz y no de un `grep` de llaves sueltas: la interfaz es lo
 * que le permite a TypeScript aceptar la escritura, así que agregar una
 * perilla sin pasar por acá no compila.
 */
function llavesDe(interfaz: string): string[] {
  const cuerpo = new RegExp(`interface ${interfaz} \\{([^}]*(?:\\{[^}]*\\}[^}]*)*)\\}`).exec(PANTALLA);
  expect(cuerpo, `no se encontró la interfaz ${interfaz}`).not.toBeNull();
  return [...cuerpo![1]!.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]!);
}

/** `l.<llave>` en `guardrailLimits`, `limits.<llave>` en `configDelPulso`. */
function elMotorLaLee(llave: string): boolean {
  return new RegExp(`\\b(?:l|limits)\\.${llave}\\b`).test(MOTOR);
}

/**
 * Las llaves que la pantalla escribe y el motor todavía NO lee, con su motivo.
 *
 * No crece sin uno escrito, y la prueba de abajo la hace caerse sola el día
 * que el motor empiece a leerla: una excepción que sobrevive a su causa es una
 * regla ablandada sin que nadie lo decidiera.
 */
const PENDIENTES: Record<string, string> = {
  firma_en_cada_mensaje:
    'La lee #1227 ("poder dejar la firma solo en el primer mensaje"), que todavía no está en ' +
    'staging. El control se agrega igual porque la llave y su defecto (`true`) ya están ' +
    'decididos ahí; cuando ese PR entre, esta fila se borra y la guarda la cubre sola.',
};

describe('ninguna perilla de la pantalla miente (#1230)', () => {
  it('cada llave de `limits` que la pantalla escribe la lee el motor', () => {
    const mudas = llavesDe('LimitesDto').filter((ll) => !(ll in PENDIENTES) && !elMotorLaLee(ll));
    expect(mudas).toEqual([]);
  });

  it('la excepción pendiente dice por qué, y se cae sola cuando el motor la lea', () => {
    for (const [llave, motivo] of Object.entries(PENDIENTES)) {
      expect(motivo.length, `${llave} necesita un motivo escrito`).toBeGreaterThan(60);
      expect(
        elMotorLaLee(llave),
        `${llave}: el motor ya la lee. Saca la fila de PENDIENTES.`,
      ).toBe(false);
    }
  });

  it('cada llave del pulso que la pantalla escribe la lee `configDelPulso`', () => {
    for (const llave of llavesDe('PulsoDto')) {
      expect(PULSO, `pulso.${llave} no la lee nadie`).toMatch(new RegExp(`\\bo\\.${llave}\\b`));
    }
  });

  it('el ritmo y el tope que la pantalla PROPONE son los que usa el motor', () => {
    // `POR_DEFECTO` de pulso.ts: los valores que aplican cuando el negocio no
    // escribió ninguno. Mostrar otros sería anunciar un ritmo y correr otro.
    const cada = /cadaMinutos:\s*(\d+)/.exec(PULSO)?.[1];
    const tope = /maxPorPersona:\s*(\d+)/.exec(PULSO)?.[1];
    expect(cada, 'no se pudo leer `cadaMinutos` de POR_DEFECTO').toBeDefined();
    expect(tope, 'no se pudo leer `maxPorPersona` de POR_DEFECTO').toBeDefined();
    expect(/PULSO_CADA_MINUTOS = (\d+)/.exec(PANTALLA)?.[1]).toBe(cada);
    expect(/PULSO_MAX_POR_PERSONA = (\d+)/.exec(PANTALLA)?.[1]).toBe(tope);
  });
});

describe('`limits` se manda entero, desde un solo lugar (#1230)', () => {
  /**
   * El PUT hace `limits = COALESCE($14::jsonb, limits)`: reemplaza el jsonb
   * completo. Un segundo literal `limits: { … }` en esta pantalla es un
   * segundo lugar donde olvidarse del spread, y olvidarse borra en silencio
   * todo lo demás que el negocio configuró.
   */
  it('hay UN solo literal de `limits`, y arranca con el spread', () => {
    expect(PANTALLA.match(/limits:\s*\{/g) ?? []).toHaveLength(1);
    expect(PANTALLA).toMatch(/limits:\s*\{\s*\.\.\.limits\b/);
  });

  it('el pulso también: UN literal, también con el spread', () => {
    expect(PANTALLA.match(/pulso:\s*\{/g) ?? []).toHaveLength(1);
    expect(PANTALLA).toMatch(/pulso:\s*\{\s*\.\.\.pulso\b/);
  });

  it('el PUT del agente sigue reemplazando `limits` entero', () => {
    // Si esto cambia a un merge en SQL, el spread deja de ser obligatorio y
    // este archivo entero sobra. Mientras diga COALESCE, no sobra.
    const agentes = fuenteLimpia(readFileSync(join(MODULO, 'agents.ts'), 'utf8'));
    expect(agentes).toMatch(/limits = COALESCE\(\$\d+::jsonb, limits\)/);
  });
});
