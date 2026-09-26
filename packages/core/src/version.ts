/**
 * Qué build está corriendo (#565).
 *
 * El workflow fija la imagen al SHA exacto del commit —`release.yml` depende de
 * eso para promover— pero nada lo exponía, así que después de mergear no había
 * forma de confirmar que lo que se mergeó fuera lo que está atendiendo, salvo
 * abrir el panel de Dokploy. Pasó de verdad: con el arreglo del canal mal
 * configurado desplegado, la única respuesta honesta a «¿ya envía?» era «el
 * deploy dice que salió bien».
 *
 * Y NO hace falta una variable nueva: `IAXTI_IMAGE` ya llega al contenedor con
 * el SHA en el tag —la decisión es de #392, para que Sentry sepa de qué versión
 * viene cada error— y es la MISMA variable que fija la imagen. Agregar un
 * `IAXTI_SHA` al lado sería una segunda copia del mismo dato, que es justo la
 * clase de cosa que después se desincroniza: la imagen diría una versión y el
 * health otra, y nada fallaría.
 *
 * El SHA no se saca con `git` dentro del contenedor: la imagen no lleva el
 * repo, y si lo llevara sería peso y una superficie más.
 *
 * Corto y nada más. Ni rama, ni autor, ni mensaje: `/health` es público y sin
 * autenticar, y la rama de un commit no le hace falta a una sonda.
 */

export interface VersionDelBuild {
  /** SHA corto, o null si el entorno no lo pasó (desarrollo local). */
  sha: string | null;
}

/**
 * El tag de una referencia de imagen, cuidando dos casos que la forma obvia
 * (`split(':').pop()`) confunde:
 *
 * - un registro con puerto (`registro:5000/iaxti`) no tiene tag y devolvería
 *   «5000/iaxti»;
 * - un digest (`iaxti@sha256:...`) no es un tag.
 */
function tagDeLaImagen(imagen: string): string | null {
  const sinDigest = imagen.split('@')[0]!;
  const corte = sinDigest.lastIndexOf(':');
  if (corte === -1) return null;
  const tag = sinDigest.slice(corte + 1);
  // Si lo que sigue a los dos puntos trae una barra, eran el puerto del
  // registro y no un tag.
  return tag.includes('/') || tag === '' ? null : tag;
}

export function versionDelBuild(): VersionDelBuild {
  const imagen = process.env.IAXTI_IMAGE?.trim();
  const tag = imagen ? tagDeLaImagen(imagen) : null;
  // `latest` y `staging` son tags que no identifican nada: decir que la versión
  // es «latest» es peor que decir que no se sabe, porque parece una respuesta.
  const sha = tag && /^[0-9a-f]{7,40}$/.test(tag) ? tag.slice(0, 12) : null;
  return { sha };
}
