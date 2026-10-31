import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalSecretStore } from '../src/secretos-en-el-vps';
import { GoogleIntegrationError } from '../src/http';

const CLAVE = randomBytes(32).toString('base64');
const TOKEN = JSON.stringify({ accessToken: 'ya29.sintetico', refreshToken: '1//sintetico', expiresAt: 1 });
let dir: string;

beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'iaxti-custodia-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

const almacen = () => createLocalSecretStore({ directorio: dir, clave: CLAVE });
const id = () => `iaxti-google-${randomBytes(8).toString('hex')}`;

it('la referencia conserva la forma que la limpieza consulta con LIKE', async () => {
  const secreto = id();
  const ref = await almacen().put(secreto, TOKEN);
  // No es estética: `limpiarVersionesGoogle` busca
  // `g.secret_ref LIKE '%/secrets/' || v.secret_ref || '/versions/%'`.
  // Una referencia con otra forma deja de encontrar nada SIN fallar, y los
  // tokens reemplazados se quedan en disco para siempre.
  expect(ref).toMatch(new RegExp(`/secrets/${secreto}/versions/[1-9][0-9]*$`));
  expect(ref.includes(`/secrets/${secreto}/versions/`)).toBe(true);
});

it('guarda, devuelve lo mismo, y en el disco no está el token en claro', async () => {
  const secreto = id();
  const ref = await almacen().put(secreto, TOKEN);
  expect(await almacen().access(ref)).toBe(TOKEN);

  const archivos = await readdir(join(dir, secreto));
  expect(archivos).toHaveLength(1);
  const crudo = await readFile(join(dir, secreto, archivos[0]));
  // Lo que importa de «cifrado en disco»: que el refresh token no se lea.
  expect(crudo.toString('utf8')).not.toContain('1//sintetico');
  expect(crudo.toString('utf8')).not.toContain('ya29');
  expect(crudo.includes(Buffer.from('refreshToken'))).toBe(false);
});

it('las versiones suben, y una destruida NO devuelve su número', async () => {
  const secreto = id();
  const a = await almacen().put(secreto, 'uno');
  const b = await almacen().addVersion(secreto, 'dos');
  expect(a.endsWith('/versions/1')).toBe(true);
  expect(b.endsWith('/versions/2')).toBe(true);

  await almacen().destroy(a);
  await expect(almacen().access(a)).rejects.toMatchObject({ code: 'GOOGLE_NOT_FOUND' });
  // La que sigue viva, sigue viva.
  expect(await almacen().access(b)).toBe('dos');

  // Y el número de la destruida no se reusa: si se reusara, una referencia
  // vieja terminaría apuntando a una credencial nueva.
  const c = await almacen().addVersion(secreto, 'tres');
  expect(c.endsWith('/versions/3')).toBe(true);
});

it('destruir dos veces no es un fallo: la cola de limpieza reintenta', async () => {
  const secreto = id();
  const ref = await almacen().put(secreto, TOKEN);
  await almacen().destroy(ref);
  await expect(almacen().destroy(ref)).resolves.toBeUndefined();
});

it('un archivo adulterado no devuelve nada, y una llave distinta tampoco', async () => {
  const secreto = id();
  const ref = await almacen().put(secreto, TOKEN);
  const archivo = join(dir, secreto, (await readdir(join(dir, secreto)))[0]);

  // Otra llave: la etiqueta de GCM no calza.
  const ajeno = createLocalSecretStore({ directorio: dir, clave: randomBytes(32).toString('base64') });
  await expect(ajeno.access(ref)).rejects.toMatchObject({ code: 'GOOGLE_RESPONSE_INVALID' });

  // Un byte cambiado: tampoco. Lo que no puede pasar es devolver algo.
  const crudo = await readFile(archivo);
  crudo[crudo.length - 1] ^= 0xff;
  await writeFile(archivo, crudo);
  await expect(almacen().access(ref)).rejects.toMatchObject({ code: 'GOOGLE_RESPONSE_INVALID' });
});

it('rechaza lo que el otro almacén rechaza: id, referencia y payload', async () => {
  const a = almacen();
  for (const malo of ['con espacio', 'con/barra', '', 'x'.repeat(256)]) {
    await expect(a.put(malo, TOKEN)).rejects.toMatchObject({ code: 'GOOGLE_INPUT_INVALID' });
  }
  for (const ref of ['otra-cosa/secrets/x/versions/1', 'custodia-local/secrets/x/versions/0',
    'custodia-local/secrets/x/versions/', 'custodia-local/secrets/x/versiones/1']) {
    await expect(a.access(ref)).rejects.toMatchObject({ code: 'GOOGLE_INPUT_INVALID' });
  }
  // Vacío y pasado de tamaño, igual que el tope de Secret Manager.
  await expect(a.put(id(), '')).rejects.toMatchObject({ code: 'GOOGLE_INPUT_INVALID' });
  await expect(a.put(id(), 'x'.repeat(65537))).rejects.toMatchObject({ code: 'GOOGLE_INPUT_INVALID' });
});

it('un payload inválido no deja el secreto creado a medias', async () => {
  const secreto = id();
  await expect(almacen().put(secreto, '')).rejects.toThrow();
  await expect(readdir(join(dir, secreto))).rejects.toThrow();
});

it('crear dos veces el mismo secreto avisa, no pisa el que había', async () => {
  const secreto = id();
  await almacen().put(secreto, TOKEN);
  await expect(almacen().put(secreto, 'otro')).rejects.toMatchObject({ code: 'GOOGLE_ALREADY_EXISTS' });
  expect(await almacen().access(`custodia-local/secrets/${secreto}/versions/1`)).toBe(TOKEN);
});

it('borrar el secreto se lleva todas sus versiones', async () => {
  const secreto = id();
  const ref = await almacen().put(secreto, TOKEN);
  await almacen().addVersion(secreto, 'dos');
  await almacen().deleteSecret(secreto);
  await expect(almacen().access(ref)).rejects.toMatchObject({ code: 'GOOGLE_NOT_FOUND' });
  // Y borrar lo que ya no está tampoco falla: la limpieza tiene que terminar.
  await expect(almacen().deleteSecret(secreto)).resolves.toBeUndefined();
});

it('sin llave de 32 bytes no arranca: no hay modo «sin cifrar»', () => {
  for (const clave of ['', 'corta', randomBytes(16).toString('base64')]) {
    expect(() => createLocalSecretStore({ directorio: dir, clave }))
      .toThrow(GoogleIntegrationError);
  }
  expect(() => createLocalSecretStore({ directorio: '', clave: CLAVE })).toThrow(GoogleIntegrationError);
});

it('una señal ya abortada no escribe nada', async () => {
  const secreto = id();
  const señal = AbortSignal.abort();
  await expect(almacen().put(secreto, TOKEN, { signal: señal }))
    .rejects.toMatchObject({ code: 'GOOGLE_REQUEST_ABORTED' });
  await expect(readdir(join(dir, secreto))).rejects.toThrow();
});
