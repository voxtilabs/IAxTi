# Observabilidad base · #17

La presencia de variables o un HTTP 200 no acredita que Grafana o Sentry estén
recibiendo datos. La issue sigue abierta hasta registrar evidencia de todos sus
criterios en staging.

## Vida y disponibilidad

Los cinco servicios exponen `/health` y `/ready` en su puerto HTTP. `/health`
comprueba que el proceso responde; Compose lo usa en web, admin, api, workers y
agents. Una caída temporal de una dependencia no debe provocar una cadena de
reinicios de procesos sanos. Un healthcheck fallido marca el contenedor como
unhealthy; la política de reinicio de Docker no reinicia por sí sola ese estado.

En staging, Dokploy usa una definición `raw`: actualizar Git no cambia ese
documento. El workflow incorpora únicamente los healthchecks ausentes de
workers/agents desde el Compose del SHA desplegado (#396), mediante
`scripts/sincronizar-healthchecks.mjs`. Conserva checks existentes, redes,
dominios, variables y volúmenes. El parche es idempotente; ante configuración
inválida o un check deshabilitado por el operador, falla sin aplicar cambios ni
imprimir el documento. Las fuentes Git conservan su gestión del archivo. El API
permite actualizar `composeFile` junto con `env`
([referencia de Dokploy](https://docs.dokploy.com/docs/api/compose)).

`/ready` debe distinguir las dependencias disponibles de las degradadas. En web
y admin este cambio responde 200 con `status: ok` o 503 si falla alguna de las
siguientes consultas, ejecutadas en paralelo:

- API: `API_URL_INTERNAL` (o `API_URL_PUBLIC` si la interna no está declarada),
  `/ready`, cuerpo con `status: ok`.
- Supabase Auth: `SUPABASE_URL` + `/auth/v1/health`, usando `SUPABASE_ANON_KEY`,
  cuerpo de salud de GoTrue. No envía correos ni crea sesiones.

Cada consulta tiene un plazo de dos segundos; un timeout, una URL inválida, una
configuración ausente, un redirect o una respuesta incompatible produce 503.
La clave se envía solamente a Auth y no se siguen redirects. Las respuestas
públicas contienen nombre lógico, resultado y duración; nunca URLs, credenciales,
cuerpos del proveedor ni mensajes de excepción. La sonda se ejecuta por petición
y responde `Cache-Control: no-store`.

Workers exige que termine su arranque y comprueba Redis y PostgreSQL; agents
comprueba Redis. Una variable ausente produce 503. Las sondas abren conexiones
de diagnóstico independientes, con plazo total de dos segundos, sin reintentos
automáticos ni cola offline; consultan `PING` y `SELECT 1` y luego cierran las
conexiones. Los errores se reducen a categorías públicas, sin host ni credencial.
Un fallo de estas dependencias mantiene `/health` disponible y degrada `/ready`.

No necesita variables nuevas ni valores de ejemplo. Comprobar con GET `/health`
y `/ready` de cada servicio después de desplegar y registrar SHA de imagen,
fecha, estado HTTP y dependencias. Para workers y agents hacerlo dentro de la red
privada; no abrir puertos públicos para monitorearlos. Usar `/ready` en el smoke
posterior al deploy; `/health` por sí solo no comprueba que el usuario pueda operar.

## Logs de plataforma por OTLP

El sobre JSON ya existía, pero solo se escribía en la consola. Ahora el mismo
sobre redactado puede salir también por OTLP HTTP/protobuf. El transporte está
**apagado por defecto**, incluso si las trazas ya tienen endpoint configurado.
Se activa con `OTEL_LOGS_EXPORTER=otlp` y `LOG_FORMAT=json`; `none`, blanco o
ausente conservan únicamente la salida local. No se habilita por desplegar este
cambio. `OTEL_EXPORTER_OTLP_LOGS_PROTOCOL` admite `http/protobuf`; una configuración
incompatible avisa localmente y no exporta logs.

El endpoint común `OTEL_EXPORTER_OTLP_ENDPOINT` recibe el sufijo `/v1/logs`.
`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, si se usa, es la URL completa del destino de
logs. No poner credenciales ni parámetros en esas URLs. Las cabeceras se leen
del mecanismo existente: `OTEL_EXPORTER_OTLP_LOGS_HEADERS` tiene precedencia sobre
`OTEL_EXPORTER_OTLP_HEADERS`; en blanco usa las comunes. Sus valores permanecen
en el gestor de secretos. Los Compose de staging/producción pasan estas variables
con el exportador `none` por defecto. **Dokploy raw requiere aplicar esas variables
al documento activo**: el parche de healthchecks no sincroniza esta sección.

El transporte solo recibe mensaje/nivel/fecha/servicio y el contexto vigente
tenant/request/trace, más el stack redactado cuando hay un Error. No captura
requests, respuestas, cuerpos de conversación ni argumentos o variables del
proceso como recursos OTel. En objetos se omiten enteros los campos de cuerpos
HTTP (`data`, `body`, `payload`, `request`, etc.), mensajes/prompts y cabeceras;
se conservan códigos/status para diagnóstico. También se redactan claves
sensibles, Bearer/Basic, credenciales y parámetros de URL, correos y teléfonos
con prefijo internacional. Se acotan tamaño y profundidad. Esto **no es un
detector universal de PII**: los productores deben seguir evitando texto del
cliente o datos personales en mensajes libres. La consola sin `LOG_FORMAT=json`
mantiene su comportamiento anterior y no se exporta por este puente.

La cola guarda hasta 512 registros, en lotes de 128, con intervalo de 1 s y
plazo de envío de 1 s. Al saturarse descarta la copia remota de los nuevos
registros, conservando la consola; no es un transporte durable ni sustituye
`audit_log`. Al apagar, se drenan primero las piezas de la aplicación y luego
la telemetría. Los fallos del exportador quedan solo en la salida local para
evitar que su propio error origine otro envío. No se instala un segundo logger
global ni se duplican los bridges automáticos del SDK.

### Receptor local reproducible

`infra/otel/docker-compose.local.yml` levanta explícitamente un Collector oficial
versionado (0.162.0), con puerto publicado solo en loopback, límite de memoria y
configuración de solo lectura. Su única salida es `debug` local: **no conecta
Grafana ni ningún servicio externo**. El puerto 4318 debe estar libre.

```sh
docker compose -f infra/otel/docker-compose.local.yml config --quiet
docker compose -f infra/otel/docker-compose.local.yml up -d
pnpm --filter @iaxti/telemetry build
LOG_FORMAT=json OTEL_LOGS_EXPORTER=otlp OTEL_EXPORTER_OTLP_ENDPOINT= SENTRY_DSN= \
  OTEL_EXPORTER_OTLP_HEADERS= OTEL_EXPORTER_OTLP_LOGS_HEADERS= \
  OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/protobuf \
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://127.0.0.1:4318/v1/logs \
  node packages/telemetry/tests/fixtures/logs-otlp.cjs
docker compose -f infra/otel/docker-compose.local.yml logs collector
docker compose -f infra/otel/docker-compose.local.yml down
```

Usar solamente datos de prueba: el exportador `debug` muestra los registros
recibidos. La fixture ejerce `initObservability`, consola, contexto y apagado
reales del paquete compilado. Para correlación y fallos, `pnpm --filter
@iaxti/telemetry test` ejecuta subprocesos con receptor HTTP local que decodifica
el protobuf recibido; comprueba tenant/request/trace, redacción, 401, timeout,
saturación y salida del proceso sin forzar `process.exit`. La evidencia del
cambio está en [el corte #17](../evidencias/17/README.md).

## Evidencia pendiente para cerrar #17

1. Un error controlado identificable de cada uno de los cinco servicios recibido
   en Sentry, sin datos personales ni contenido de conversaciones.
   Comprobar también que la definición raw entregue `IAXTI_IMAGE` (#392): su
   declaración en Git no acredita que el proceso reciba la versión.
2. Una traza request → job con el mismo `trace_id`, recibida en Grafana; métricas
   y logs de plataforma recibidos en sus destinos, con `tenant_id` cuando aplica.
   Los tests con receptores locales no sustituyen esta comprobación externa.
3. Monitores activos de Uptime Kuma sobre API, agents y web. Registrar una caída
   controlada del monitor y su recuperación sin detener servicios compartidos.
4. Cuatro alertas configuradas y con prueba de entrega: error rate de API,
   latencia p95, cola atascada y disco sobre 80 %. Registrar umbral, ventana,
   destino y evidencia de recepción, sin publicar credenciales del destino.

La credencial de exportación debe ser válida en el gestor de secretos del
ambiente. No reemplazarla por un texto de ejemplo ni copiarla al repositorio o a
comentarios. Un valor incompleto de autorización OTLP sigue siendo un bloqueo
operativo aunque las sondas de disponibilidad estén verdes.

Las interrupciones durante recreación de contenedores se siguen en #254; las
sondas no convierten el despliegue Compose en uno sin cortes. El rol de base de
datos que omite RLS se sigue en #370 y tampoco queda corregido por este cambio.
