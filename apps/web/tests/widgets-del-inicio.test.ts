import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Los widgets del inicio (#517).
 *
 * Los módulos los declaran en su `module.yaml`, la API los entrega en
 * `GET /me/modules` —y su comentario dice desde el principio que «el frontend
 * arma navegación y widgets desde aquí»— y ningún componente los leía. Dos
 * widgets declarados que nadie dibujaba, y un inicio que le mostraba a un
 * negocio de hace seis meses el checklist de lo que ya hizo.
 *
 * Esta guarda mira los DOS sentidos, porque el defecto entra por los dos:
 * un id declarado sin componente es un widget invisible, y un componente sin
 * declarar es uno que ningún interruptor de módulo apaga ni ningún permiso
 * filtra.
 */
const RAIZ = join(__dirname, '..', '..', '..');
const MODULOS = join(RAIZ, 'packages', 'modules');
const FUENTE = readFileSync(join(__dirname, '..', 'components', 'inicio', 'widgets.tsx'), 'utf8');

/** Los ids que declara cada `module.yaml`, leídos del YAML sin parsearlo entero. */
function declarados(): Array<{ modulo: string; id: string; permission: string }> {
  const salida: Array<{ modulo: string; id: string; permission: string }> = [];
  for (const modulo of readdirSync(MODULOS)) {
    let yaml: string;
    try {
      yaml = readFileSync(join(MODULOS, modulo, 'module.yaml'), 'utf8');
    } catch {
      continue;
    }
    const bloque = /^widgets:\s*\n((?:\s+-.*\n?)*)/m.exec(yaml) ?? /^widgets:(.*)$/m.exec(yaml);
    if (!bloque) continue;
    for (const linea of bloque[1].split('\n')) {
      const id = /id:\s*([\w.]+)/.exec(linea);
      const permiso = /permission:\s*([\w.]+)/.exec(linea);
      if (id) salida.push({ modulo, id: id[1], permission: permiso?.[1] ?? '' });
    }
  }
  return salida;
}

/** Los ids que el frontend sabe dibujar, leídos del mapa `WIDGETS`. */
function conComponente(): string[] {
  const mapa = /export const WIDGETS[^{]*\{([\s\S]*?)\n\};/.exec(FUENTE);
  if (!mapa) throw new Error('No encontramos el mapa WIDGETS en widgets.tsx.');
  return [...mapa[1].matchAll(/'([\w.]+)':/g)].map((m) => m[1]);
}

describe('los widgets declarados y los dibujados son los mismos (#517)', () => {
  const delManifiesto = declarados();
  const delFrontend = conComponente();

  it('el escáner encuentra algo (si esto falla, el escáner se rompió)', () => {
    expect(delManifiesto.length).toBeGreaterThan(0);
    expect(delFrontend.length).toBeGreaterThan(0);
  });

  it('cada widget declarado tiene quién lo dibuje', () => {
    const invisibles = delManifiesto
      .filter((w) => !delFrontend.includes(w.id))
      .map((w) => `${w.id} (lo declara ${w.modulo})`);
    expect(
      invisibles,
      'Declarados y sin componente: el manifiesto promete algo que el inicio no ' +
        'muestra. Agrégalos a WIDGETS en components/inicio/widgets.tsx o sácalos ' +
        'del module.yaml:\n  ' + invisibles.join('\n  '),
    ).toEqual([]);
  });

  it('cada componente está declarado en el manifiesto de su módulo', () => {
    // Sin declarar, el widget se dibuja siempre: no lo apaga el interruptor
    // del módulo (SPEC §26 regla 5) ni lo filtra su permiso.
    const ids = new Set(delManifiesto.map((w) => w.id));
    const sueltos = delFrontend.filter((id) => !ids.has(id));
    expect(
      sueltos,
      'Dibujados y sin declarar: ningún interruptor de módulo los apaga.\n  ' + sueltos.join('\n  '),
    ).toEqual([]);
  });

  it('cada widget declara un permiso, y el prefijo es de su módulo', () => {
    // El permiso es lo que decide quién lo ve. Vacío, lo vería cualquiera.
    for (const w of delManifiesto) {
      expect(w.permission, `${w.id} sin permiso`).not.toBe('');
      // `conversations.sin_responder` pide `conversations.read`: el widget de
      // un módulo no puede colgarse del permiso de otro, porque entonces
      // apagar ese otro módulo dejaría el widget sin poder pedir sus datos.
      expect(w.permission.split('.')[0], `${w.id} pide un permiso de otro módulo`).toBe(
        w.id.split('.')[0],
      );
    }
  });

  it('los permisos no se comprueban en el cliente: los datos los pide la ruta', () => {
    // No hay lista de permisos en el frontend, y una que hubiera podría
    // discrepar de la del servidor. Cada widget pide sus datos a la ruta que
    // ya exige el permiso; si no lo tiene, falla y el widget no se dibuja.
    expect(FUENTE).toContain('apiFetch');
    expect(FUENTE, 'un widget que cae no puede dejar una caja vacía').toContain('return null');
  });

  it('el inicio solo muestra los widgets cuando el negocio está en marcha', () => {
    // A medio configurar, lo que importa es el paso que falta; los números de
    // un negocio que todavía no atiende serían todos cero.
    const puesta = readFileSync(
      join(__dirname, '..', 'components', 'puesta-en-marcha.tsx'),
      'utf8',
    );
    expect(puesta).toContain('{estado.completo && <WidgetsDelInicio');
  });
});
