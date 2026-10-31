# 0028 · La custodia de los tokens de Google vive en el VPS (v1)

Estado: aceptado para v1. Desvía ADR-0027, que sigue vigente en todo lo demás.

## Qué cambia

ADR-0027 dice, textual: «Los tokens completos viven únicamente en Secret
Manager». A partir de acá el despliegue puede elegir dónde viven, y v1 los
guarda **cifrados en disco en el VPS**.

El puerto no cambia. `GoogleSecretStore` sigue siendo los mismos cinco
métodos, y `calendarGoogleDesdeEntorno` decide qué implementación inyecta
mirando el entorno. Calendar e identity no saben cuál les tocó, y volver a
Secret Manager —o irse a un tercero— es cambiar variables, no código.

## Por qué

Secret Manager arrastra el resto de Google Cloud: proyecto facturable,
credenciales de servicio, IAM y una dependencia de red en el camino de
conexión de cada persona. Para v1, con la aplicación y la base en la misma
máquina, eso compra menos de lo que cuesta.

Y lo que compra hay que decirlo con precisión, porque es la parte que se
pierde: Secret Manager da rotación gestionada, control de acceso por
identidad y su propio registro de accesos. En el VPS la protección es el
cifrado en disco más la llave del entorno. **Quien pueda leer el disco Y el
entorno del proceso, puede leer los tokens.**

Lo que NO se pierde: hoy esa misma persona ya puede leer la base y las
credenciales del canal, que están en el mismo entorno. Así que en v1 no se
está derribando una frontera que existiera de verdad — se está eligiendo no
construirla todavía. El día que la aplicación se reparta en más de una
máquina, o que haya clientes cuyo contrato exija custodia separada, esto se
revisa, y por eso el puerto quedó intacto.

## Cómo

- AES-256-GCM. La etiqueta de autenticación hace de verificación de
  integridad, que es lo que en Secret Manager hacía el CRC32C: un archivo
  adulterado o una llave distinta no devuelven nada, nunca devuelven algo
  parecido.
- Sin modo «sin cifrar». Si falta la llave de 32 bytes, el almacén no se
  construye.
- Escritura por archivo temporal y `rename`: un proceso muerto a la mitad no
  deja media credencial.
- `GOOGLE_SECRET_DIR` tiene que apuntar a un **volumen que sobreviva al
  redespliegue**. En un directorio efímero los tokens se pierden en el
  siguiente deploy y cada persona tiene que volver a conectar su calendario.

## Dos cosas que no son detalle

**La forma de la referencia se conserva.** Sigue siendo
`…/secrets/<id>/versions/<n>`, porque la recolección de versiones
reemplazadas decide qué sigue en uso con

```sql
g.secret_ref LIKE '%/secrets/' || v.secret_ref || '/versions/%'
```

o sea comparando la forma. Una referencia distinta dejaría de calzar **sin
fallar**: en un sentido el barrido nunca recogería nada y los tokens viejos
se quedarían en disco para siempre; en el otro se llevaría por delante el
secreto de un grant vivo. Lo sostiene una prueba que usa el almacén real
contra disco y la base real, y su mordida comprueba las dos direcciones.

**Los números de versión solo suben.** Una versión destruida deja una lápida
en vez de desaparecer. Si el número se reusara, una referencia vieja
terminaría apuntando a una credencial nueva.

## Elegir una, nunca media

Si están las variables de las dos custodias gana la local. Si falta un pedazo
de la elegida, `calendarGoogleDesdeEntorno` devuelve `null` y Calendar queda
apagado, que es lo que ya hacía cuando faltaba cualquier variable.

Lo que a propósito **no** se hace es caer de una a la otra en silencio: un
despliegue que cree estar guardando en Secret Manager y esté escribiendo en un
disco efímero es justo la clase de sorpresa que no se descubre hasta el día
que se pierden los tokens.

## Lo que este ADR no toca

Todo lo demás de ADR-0027 sigue igual: la intención durable previa a crear un
secreto, el bloqueo antes de revocar, `revoking` ante un resultado remoto
incierto, los cerrojos por cuenta, la auditoría en la misma transacción y que
`@iaxti/google` no conozca tablas ni módulos de negocio.
