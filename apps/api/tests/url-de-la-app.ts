import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';

/**
 * La URL de la app levantada en un puerto efímero (#1061).
 *
 * `app.getUrl()` de Nest devuelve lo que el servidor reporta como dirección,
 * y con `listen(0)` eso llega a ser `http://[::]:0` o `http://0.0.0.0:46123`
 * según cómo quede el bind: undici rechaza las dos con **`Error: bad port`**
 * o un fetch que no resuelve. Pasa solo con la máquina cargada —tres veces en
 * dos días, en archivos distintos y ramas que no tocaban esto— y pinta rojo
 * el cambio de otro, que es la peor clase de rojo (#776).
 *
 * Acá se lee el puerto REAL del server y se arma la URL con `127.0.0.1`,
 * que es donde el test siempre pega.
 */
export function urlDeLaApp(app: INestApplication): string {
  const server = app.getHttpServer() as { address: () => AddressInfo | string | null };
  const dir = server.address();
  if (!dir || typeof dir === 'string') {
    throw new Error('La app no está escuchando todavía: llamá a urlDeLaApp DESPUÉS de app.listen.');
  }
  return `http://127.0.0.1:${dir.port}`;
}
