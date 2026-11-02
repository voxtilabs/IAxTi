import { expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

/**
 * Esta prueba simula el errno, y no usa permisos de verdad, por una razón que
 * conviene dejar escrita: **las pruebas corren como root**, y root ignora los
 * bits de permiso. La escribí primero con `chmod 0o500` y pasó —`put` resolvió
 * en vez de fallar— porque root escribe igual. Una prueba de permisos que corre
 * como root no prueba nada; afirma que el entorno es laxo.
 *
 * Y lo que se quiere afirmar acá no es el sistema de archivos: es la
 * CLASIFICACIÓN. «Cuando mkdir dice EACCES, ¿qué lanzamos?» es una pregunta
 * sobre nuestro código, y simular el errno es el instrumento exacto.
 */
/**
 * `vi.hoisted` y no un `const` normal: `vi.mock` se iza por encima de los
 * imports, así que su fábrica corre antes de que un `const` de arriba exista.
 * Lo intenté primero con `await import(...)` a nivel superior para esquivarlo y
 * el typecheck lo rechazó (TS1378) — con razón: el patrón de esta casa para
 * esto es `vi.hoisted`, que ya se usa en las pruebas de la invitación.
 */
const { mkdir } = vi.hoisted(() => ({ mkdir: vi.fn() }));
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<object>()),
  mkdir,
}));
import { createLocalSecretStore } from '../src/secretos-en-el-vps';
const CLAVE = randomBytes(32).toString('base64');
const TOKEN = JSON.stringify({ accessToken: 'ya29.sintetico', refreshToken: '1//sintetico', expiresAt: 1 });
const almacen = () => createLocalSecretStore({ directorio: '/datos/secretos', clave: CLAVE });
const errno = (code: string) => Object.assign(new Error(code), { code });

it('EACCES se dice con su nombre, la ruta y qué hacer (#1192)', async () => {
  mkdir.mockReset();
  mkdir.mockRejectedValue(errno('EACCES'));
  const put = almacen().put('iaxti-google-prueba', TOKEN);
  await expect(put).rejects.toMatchObject({ name: 'CustodiaSinPermiso' });
  await expect(almacen().put('iaxti-google-prueba', TOKEN)).rejects.toThrow('/datos/secretos');
  // Qué hacer, no solo qué pasó.
  await expect(almacen().put('iaxti-google-prueba', TOKEN)).rejects.toThrow(/1000/);
  // Y nunca el secreto.
  await expect(almacen().put('iaxti-google-prueba', TOKEN)).rejects.not.toThrow(/sintetico/);
});

it('EPERM también: es el mismo problema con otro nombre', async () => {
  mkdir.mockReset();
  mkdir.mockRejectedValue(errno('EPERM'));
  await expect(almacen().put('iaxti-google-prueba', TOKEN)).rejects.toMatchObject({
    name: 'CustodiaSinPermiso',
  });
});

it('un errno que no es de permisos pasa TAL CUAL', async () => {
  // Inventarle un nombre a lo que no se entiende es cómo se pierde el error de
  // verdad. Un disco lleno no es un permiso mal puesto.
  mkdir.mockReset();
  mkdir.mockRejectedValue(errno('ENOSPC'));
  await expect(almacen().put('iaxti-google-prueba', TOKEN)).rejects.toMatchObject({ code: 'ENOSPC' });
});

it('EEXIST sigue siendo GOOGLE_ALREADY_EXISTS y no un permiso', async () => {
  // Clasificar EACCES no puede tragarse EEXIST, que tiene su propio
  // significado y su propio camino en la limpieza.
  mkdir.mockReset();
  mkdir.mockRejectedValue(errno('EEXIST'));
  await expect(almacen().put('iaxti-google-prueba', TOKEN)).rejects.toMatchObject({
    code: 'GOOGLE_ALREADY_EXISTS',
  });
});

it('ENOENT reintenta creando el directorio base, y si ESO no se puede, lo dice', async () => {
  // El camino que ya existía: si falta el directorio base se crea. Lo nuevo es
  // que si la segunda también falla por permisos, no sube un errno crudo.
  mkdir.mockReset();
  mkdir.mockRejectedValueOnce(errno('ENOENT')).mockRejectedValue(errno('EACCES'));
  await expect(almacen().put('iaxti-google-prueba', TOKEN)).rejects.toMatchObject({
    name: 'CustodiaSinPermiso',
  });
});
