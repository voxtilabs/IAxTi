import { createPool } from './client';
import { comoSeLee, permisosDelRol } from './permisos-del-rol';

/**
 * El paso previo a cambiar la cadena de conexión (#370).
 *
 * Se corre CON EL ROL NUEVO —`DATABASE_URL` apuntando a él— y no escribe
 * nada: solo pregunta al catálogo. Sale con código 1 si falta algo, para
 * que un despliegue que lo incluya se detenga antes de dejar la aplicación
 * sin permisos en vez de después.
 */
async function main() {
  const pool = createPool();
  try {
    const d = await permisosDelRol(pool);
    console.log(comoSeLee(d));
    if (!d.listo) process.exit(1);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
