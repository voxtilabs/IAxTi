import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fuenteLimpia } from '@iaxti/core/testing';

/**
 * Cada tipo de aviso tiene nombre en la pantalla de preferencias (#1346).
 *
 * La tabla de `/ajustes/notificaciones` mostraba «estado_cuenta» y
 * «cupo_del_canal» como si fueran nombres: el módulo los agregó a
 * `NOTIFICATION_TYPES` y la pantalla, que tiene su propia lista (no puede
 * importar el módulo: el frontend habla por la API), nunca se enteró. Esta
 * guarda lee las dos fuentes y exige que la segunda cubra a la primera.
 *
 * Y de pasada, la otra regla de copy que se vio en la misma revisión: ningún
 * placeholder termina en «…» (ui-meson.md).
 */
const RAIZ = join(__dirname, '..', '..', '..');

describe('los nombres de los avisos', () => {
  const modulo = fuenteLimpia(readFileSync(join(RAIZ, 'packages/modules/notifications/application/notifications.ts'), 'utf8'));
  const lista = modulo.match(/NOTIFICATION_TYPES = \[([\s\S]*?)\] as const/);
  const tipos = [...(lista?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
  const pantalla = fuenteLimpia(readFileSync(join(__dirname, '../components/preferencias-avisos.tsx'), 'utf8'));

  it('encuentra los tipos del módulo (si no, la guarda no mide nada)', () => {
    expect(tipos.length).toBeGreaterThan(5);
  });

  it('la pantalla le da nombre a cada uno', () => {
    const sinNombre = tipos.filter((t) => !new RegExp(`\\b${t}: '`).test(pantalla));
    expect(sinNombre, 'tipos de aviso que se verían con la llave cruda').toEqual([]);
  });
});

describe('los placeholders', () => {
  function archivos(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) return archivos(p);
      return p.endsWith('.tsx') && !p.endsWith('.test.tsx') ? [p] : [];
    });
  }

  it('ninguno termina en «…»', () => {
    const conPuntos = [...archivos(join(__dirname, '../components')), ...archivos(join(__dirname, '../app'))].flatMap((f) => {
      const fuente = fuenteLimpia(readFileSync(f, 'utf8'));
      return [...fuente.matchAll(/placeholder="([^"]*…)"/g)].map((m) => `${f.split('/apps/web/')[1]}: ${m[1]}`);
    });
    expect(conPuntos).toEqual([]);
  });
});
