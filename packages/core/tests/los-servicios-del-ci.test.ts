import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Ninguna imagen de ningún workflow depende de un cupo anónimo (#877).
 *
 * Lo que costó, dos veces:
 *
 *  - **#760.** Los `services:` del CI salían de Docker Hub, que limita las
 *    descargas anónimas por IP y las IP de los runners son compartidas. El job
 *    moría en «Initialize containers» sin decir nada útil.
 *  - **#877.** El arreglo movió redis a `public.ecr.aws`, con el argumento de
 *    que ahí las oficiales «permiten descargas anónimas sin el cupo de Docker
 *    Hub». Cierto, y con la premisa equivocada: ECR público tiene el suyo. El
 *    12-10 lo agotó, con tres `toomanyrequests: Data limit exceeded`, y se cayó
 *    el CI del PR que arreglaba la velocidad de la IA.
 *
 * Entre las dos, la lección escrita en `ci.yml` era «no apuntes a Docker Hub»,
 * y por eso ECR pasó. La lección de verdad es otra, y es la que vigila esto:
 * **el problema no es el registro, es depender de un cupo que fija alguien que
 * no somos nosotros.** Una imagen con credenciales no tiene cupo para nosotros;
 * una sin credenciales lo tiene, venga de donde venga.
 *
 * Por eso la guarda no es una lista negra de registros —eso es lo que falló—
 * sino una regla sobre la FORMA: si hay `image:`, hay `credentials:`.
 */
const WORKFLOWS = join(__dirname, '../../../.github/workflows');

/** Cada bloque `image:` de un `services:`, con el archivo donde vive. */
function serviciosDeclarados(): Array<{ archivo: string; imagen: string; conCredenciales: boolean }> {
  const encontrados: Array<{ archivo: string; imagen: string; conCredenciales: boolean }> = [];
  for (const archivo of readdirSync(WORKFLOWS).filter((f) => f.endsWith('.yml'))) {
    const lineas = readFileSync(join(WORKFLOWS, archivo), 'utf8').split('\n');
    for (let i = 0; i < lineas.length; i += 1) {
      const m = /^(\s+)image:\s*(\S+)\s*$/.exec(lineas[i]);
      if (!m) continue;
      const sangria = m[1].length;
      // `credentials:` es hermano de `image:`, así que tiene la MISMA sangría
      // y aparece en las líneas siguientes del mismo bloque. Se mira hasta que
      // la sangría baje, que es donde el bloque del servicio termina.
      let conCredenciales = false;
      for (let j = i + 1; j < lineas.length; j += 1) {
        const l = lineas[j];
        if (l.trim() === '' || l.trim().startsWith('#')) continue;
        const propia = l.length - l.trimStart().length;
        if (propia < sangria) break;
        if (propia === sangria && /^\s+credentials:/.test(l)) {
          conCredenciales = true;
          break;
        }
      }
      encontrados.push({ archivo, imagen: m[2], conCredenciales });
    }
  }
  return encontrados;
}

describe('los servicios del CI no dependen de un cupo ajeno (#877)', () => {
  const servicios = serviciosDeclarados();

  it('la guarda está mirando algo', () => {
    // Anti-vacuidad: si el escáner dejara de encontrar los `image:`, lo de
    // abajo pasaría sin medir nada — que es la forma en que una guarda deja de
    // servir sin que nadie lo note.
    expect(servicios.length).toBeGreaterThanOrEqual(2);
    expect(servicios.some((s) => s.archivo === 'ci.yml')).toBe(true);
  });

  it('toda imagen de un servicio se baja CON credenciales', () => {
    const sinCredenciales = servicios.filter((s) => !s.conCredenciales);
    expect(
      sinCredenciales.map((s) => `${s.archivo}: ${s.imagen}`),
      'Estas imágenes se bajan sin credenciales, así que dependen de un cupo anónimo que fija ' +
        'alguien que no somos nosotros. Cuando se agota, el job muere en «Initialize ' +
        'containers» y TODO PR queda rojo — pasó con Docker Hub (#760) y con ECR público ' +
        '(#877). Espejá la imagen en GHCR como las otras: el patrón está en ' +
        '`imagen-postgres-ci.yml` y `imagen-redis-ci.yml`.\n  ' +
        sinCredenciales.map((s) => `${s.archivo}: ${s.imagen}`).join('\n  '),
    ).toEqual([]);
  });

  it('y cada una tiene su workflow que la mantiene al día', () => {
    // Un espejo que nadie refresca envejece: la etiqueta de origen es móvil, y
    // una copia de hace un año no es la imagen que el CI dice usar.
    const archivos = readdirSync(WORKFLOWS);
    const nuestras = servicios.filter((s) => s.imagen.startsWith('ghcr.io/voxtilabs/'));
    expect(nuestras.length).toBeGreaterThanOrEqual(2);

    for (const s of nuestras) {
      // `ghcr.io/voxtilabs/redis-ci:7` → se busca un workflow que la nombre.
      const nombra = archivos
        .filter((f) => f.endsWith('.yml'))
        .some((f) => readFileSync(join(WORKFLOWS, f), 'utf8').includes(s.imagen));
      expect(
        nombra,
        `${s.imagen} la usa el CI y ningún workflow la publica: la copia no se refresca sola.`,
      ).toBe(true);
    }
  });
});

/**
 * Ningún workflow baja su herramienta de un cupo ajeno (#765).
 *
 * La guarda de arriba cuida los `services:`. Esta cuida lo otro: las ACCIONES
 * que descargan un contenedor para funcionar.
 *
 * `docker/setup-buildx-action` arranca BuildKit en un contenedor y para eso
 * descarga `moby/buildkit:buildx-stable-1` **de Docker Hub**. Un `services:`
 * sin credenciales deja un PR rojo; esto dejaba sin publicar la imagen de
 * staging y producción, y se descubría cuando alguien quería desplegar.
 *
 * Y el caché que buildx habilitaba estaba medido en NEGATIVO: 84,4 s
 * exportando para comprar medio segundo, porque lo caro del build —turbo, con
 * «0 cached, 30 total»— no se puede cachear por capas. Ver `build.yml`.
 *
 * El demonio del runner trae BuildKit adentro: `docker build` no descarga nada.
 */
describe('ninguna acción baja su contenedor de un cupo ajeno (#765)', () => {
  /** Las que arrancan un contenedor propio para trabajar. */
  const BAJAN_CONTENEDOR = [
    { accion: 'docker/setup-buildx-action', baja: 'moby/buildkit, de Docker Hub' },
    { accion: 'docker/build-push-action', baja: 'buildx, que a su vez baja moby/buildkit' },
  ];

  const archivos = readdirSync(WORKFLOWS).filter((f) => f.endsWith('.yml'));

  it('la guarda está mirando algo', () => {
    expect(archivos.length).toBeGreaterThan(5);
    // Y que de verdad sepa leer un `uses:`, o no mediría nada.
    const algunUses = archivos.some((f) =>
      /^\s*-?\s*uses:/m.test(readFileSync(join(WORKFLOWS, f), 'utf8')),
    );
    expect(algunUses).toBe(true);
  });

  it.each(BAJAN_CONTENEDOR)('$accion no se usa en ningún workflow', ({ accion, baja }) => {
    const culpables = archivos.filter((f) => {
      // Solo el YAML, no los comentarios: los de `build.yml` y
      // `imagen-postgres-ci.yml` NOMBRAN estas acciones a propósito para
      // contar por qué no están. Mirarlos pondría la guarda roja por el texto
      // que la explica — pasó cinco veces en este repo (#569).
      const sql = readFileSync(join(WORKFLOWS, f), 'utf8')
        .split('\n')
        .filter((l) => !l.trimStart().startsWith('#'))
        .join('\n');
      return sql.includes(accion);
    });
    expect(
      culpables,
      `${accion} descarga ${baja}, o sea un cupo que fija alguien que no somos nosotros. ` +
        'Un cupo agotado acá no deja un PR rojo: deja sin publicar la imagen de staging y ' +
        'producción, y se descubre cuando alguien quiere desplegar. El demonio del runner trae ' +
        'BuildKit adentro: `docker build` no descarga nada. El patrón está en `build.yml` y en ' +
        '`imagen-postgres-ci.yml`, los dos con la medición de lo que cuesta el caché que se ' +
        `pierde.\n  ${culpables.join('\n  ')}`,
    ).toEqual([]);
  });
});
