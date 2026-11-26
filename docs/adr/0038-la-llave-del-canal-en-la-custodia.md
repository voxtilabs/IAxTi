# ADR-0038 · La llave de cada canal en la custodia cifrada

- **Estado:** aceptada
- **Fecha:** 2026-11-26
- **Issue:** #1393
- **Cambia:** SPEC §17 («las credenciales se guardan por referencia») se
  mantiene, y la referencia puede apuntar a una segunda parte. Amplía
  ADR-0028 (la custodia cifrada en el VPS) de los tokens de Google y el
  secreto del webhook a la llave del proveedor del canal.

## Contexto

Una cuenta de canal guarda en `credential_ref` el NOMBRE de una variable de
entorno, nunca el valor (SPEC §17, #801). Para WhatsApp por Zernio
(ADR-0032), cada negocio tiene su propia llave, restringida a su perfil. Eso
quiere decir que conectar un negocio era:

1. correr `scripts/conectar-zernio.mjs` con la llave del operador,
2. copiar la llave nueva y el secreto del webhook que imprime,
3. pegarlos en las variables del despliegue y **redesplegar**.

Funciona para el número de VoxTi. Para salir del MVP no: cada pyme que
quiere conectar su WhatsApp depende de que alguien de VoxTi toque el
despliegue, y la pantalla de Canales solo podía ofrecer «escríbenos» (#1391).

La pieza que falta ya existe. ADR-0028 dejó una custodia cifrada en disco
(AES-256-GCM, la llave en el entorno, el volumen `secretos-del-canal`
montado en `api` y `workers` desde #1176), y el secreto del webhook ya se lee
de ahí.

## La decisión

**`credential_ref` y `webhook_secret_ref` aceptan, además de un nombre de
variable, una referencia a la custodia con la forma `cu:…`.** El alta desde
la app (`POST /v1/channels/whatsapp/conectar`) escribe esa forma; el script
de soporte sigue escribiendo nombres de variable, y las cuentas existentes no
se tocan.

```
cu:<espacio>/secrets/iaxti-canal-<tenant>-<cuenta>-<llave|webhook>-<azar>/versions/<n>
```

Las reglas:

1. **Ningún secreto pasa por la base ni por el navegador.** La llave del
   negocio sale de Zernio y entra a la custodia en el mismo proceso. La
   respuesta de la API no la trae, la auditoría tampoco (ni la referencia
   completa: solo «entorno → custodia»). La prueba busca la llave y el
   secreto como texto en `channel_accounts` y `audit_log` y exige cero.
2. **La referencia se resuelve solo para su cuenta y su tipo.** El id lleva
   el tenant, la cuenta y si es `llave` o `webhook`; quien lee comprueba los
   tres. Una referencia copiada a otra fila, de otro negocio o al otro
   campo, se lee como «no hay credencial».
3. **Un solo lector.** `credencialDeLaCuenta` (`@iaxti/module-whatsapp`) es
   el único que traduce la referencia: el envío, el diagnóstico, las
   plantillas y la descarga de adjuntos hacían cada uno
   `process.env[credentialRef]`. La guarda
   `la-llave-del-canal-se-lee-en-un-solo-lugar` impide la quinta copia.
4. **Una sola escritura.** `fijarSecretosDelCanal` (módulo `channels`, dueño
   de la tabla) es lo único que cambia las referencias después del alta, y
   rechaza las que no son de esa cuenta.
5. **Una cuenta sin llave no se activa.** El alta crea la cuenta en
   `connecting` sin referencias (el webhook necesita su id), guarda los
   secretos y recién entonces, en otra transacción, la apunta a ellos y la
   activa. Si algo se corta en el medio, la cuenta queda `connecting` —no
   manda ni recibe—, lo guardado se borra, la llave nueva de Zernio también,
   y reconectar la termina.
6. **La regla de #593 se mantiene.** Fuera de producción, un número de Zernio
   manda de verdad; el alta desde la app exige `ZERNIO_ENVIOS_REALES=1` en el
   despliegue igual que el script, y el canal queda marcado.

## Lo que no cambia, y por qué

- **Los pagos** (`payment_providers.credential_ref`) siguen por variable de
  entorno: tienen un proveedor por despliegue, no uno por negocio.
- **La custodia es la misma** que la de Google (ADR-0028): un almacén por
  despliegue, sin modo «sin cifrar». Sin `GOOGLE_SECRET_DIR` y
  `GOOGLE_SECRET_KEY`, el alta responde 503 y no cae a guardar en claro.

## Consecuencias

- **Lo que se gana:** una pyme conecta su WhatsApp sola desde Ajustes →
  Canales, sin redesplegar.
- **Lo que pesa más:** la custodia pasa a ser imprescindible para mandar
  mensajes, no solo para recibir. Perder `GOOGLE_SECRET_KEY` o el volumen
  deja mudos a los canales conectados desde la app hasta reconectarlos. El
  diagnóstico lo dice («está guardada, pero no la pudimos leer») y la salida
  es reconectar. El respaldo del volumen entra al runbook.
- **Llaves viejas en Zernio:** reconectar crea una llave nueva y destruye la
  anterior de la custodia, pero no borra la anterior en Zernio, porque otro
  número del mismo perfil podría estar usándola desde el entorno. Quedan
  vivas hasta limpiarlas a mano; el script lista cuáles. Si se vuelve un
  problema, la limpieza va en su propio issue.
- **El día que la aplicación se reparta en varias máquinas**, aplica lo
  mismo que dice ADR-0028: disco local deja de alcanzar y se pasa a Secret
  Manager, que la referencia `cu:` ya admite (`cu:projects/…`).
