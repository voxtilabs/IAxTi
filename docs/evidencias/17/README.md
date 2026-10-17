# #17 · transporte de logs de plataforma

[Issue y comentarios completos](https://github.com/voxtilabs/IAxTi/issues/17),
leídos el 16-10-2026; base `79936e77bfa57ebcfbcc16b81888af2fdb9983c7`.
Este cambio no cierra la issue ni acredita un despliegue o recepción en Grafana.

| Criterio original | Código y evidencia | Límite actual |
|---|---|---|
| Sentry capturando errores en web, admin, api, workers y agents | `initObservability` ya está en los cinco servicios y `onRequestError` ya existe en ambos Next. La regresión de telemetría conserva los tests de captura. | Falta evidencia externa identificable de los cinco servicios; no se enviaron errores a Sentry. |
| OTel exportando trazas, métricas y logs de plataforma a Grafana Cloud, con `tenant_id` en logs estructurados | Las trazas y `metricReader` ya existen. Se añade el puente console JSON → LoggerProvider → OTLP/protobuf opt-in, con el mismo sobre redactado. `logs-otlp.test.ts` decodifica envíos HTTP reales de subprocesos; el Collector oficial local recibe eventos. | La recepción local no acredita Grafana ni una credencial remota válida. |
| `/health` (vivo) y `/ready` (listo) en cada servicio, usados por Dokploy | Rutas, sondas de dependencias y healthchecks versionados ya existen; no se alteran. | El estado de una definición raw y su despliegue requiere verificación del entorno real. |
| Uptime Kuma sobre `/health` de api, agents y web | Procedimiento y evidencia requerida conservados en el runbook. | No se accedió a Kuma ni se inventaron monitores. |
| Alertas mínimas: error rate de API, latencia p95, cola atascada, disco sobre 80 % | Se conserva el requisito de configuración y prueba de recepción del runbook. | No se crean umbrales ni alertas ficticias; requiere entorno/destino autorizado. |
| Mismo `trace_id` propagado desde el request hasta el job | Se reutilizan `contextoDeTraza` y `conTrazaDelJob`; el test del transporte coteja el trace id binario OTLP de request/job y el atributo del sobre, con span id distinto y dos tenants concurrentes. | No sustituye comprobar el recorrido desplegado y su recepción remota. |

El comentario del 11-10 señalaba métricas y captura Next ausentes. Se contrastó
con la base actual: ambos arreglos ya estaban en el código y no se rehacen.
La brecha comprobada era que el sobre JSON no se enviaba a un exportador de logs.

## Contrato y pruebas

- Apagado por defecto: `OTEL_LOGS_EXPORTER=otlp` requiere `LOG_FORMAT=json`,
  endpoint válido y logs HTTP/protobuf. Los Compose no activan destinos existentes.
- Se conserva una salida local por llamada y una copia remota cuando se activa.
  Diagnósticos del SDK son solo locales; no pueden alimentar otra exportación.
- Recurso de logs con `service.name`, sin detector de argumentos/env del proceso.
  Los únicos atributos son servicio, tenant/request/trace y stack redactado.
- Redacción antes de ambas salidas JSON y OTLP; cuerpos de errores HTTP/Axios,
  prompts y conversaciones anidados se omiten enteros, conservando status/code.
  No se promete detección universal de datos personales en texto libre.
- Cola y lotes limitados; pruebas de 700 registros, 401, TCP que no responde y
  drenaje final idempotente. Los subprocesos deben salir sin `process.exit`.
- Sin endpoints, tablas, módulos de negocio, tools, UI o migraciones nuevas.
  `module-check` corresponde a fronteras/dependencias; `security-review` a
  datos exportados/redacción/configuración. La fila técnica de minimización en
  `COMPLIANCE_BASELINE` se actualiza sin afirmaciones legales.

Las dependencias de logs se fijan a 0.54.2 para coincidir con NodeSDK existente;
no se actualiza toda la familia OTel. `protobufjs` solo se usa en tests para
decodificar el protocolo del receptor. Collector 0.162.0 se ejecutó localmente
con configuración validada, sin exportadores remotos, y se retiró al terminar.
Instrucciones reproducibles en el [runbook](../../runbooks/OBSERVABILIDAD.md).

## Resultado local del corte

`pnpm antes-de-empujar` terminó con código 0 sin filtros manuales: 2.898 tests
aprobados y 14 omitidos existentes en 28 paquetes, tipos 54/54 tareas y build
30/30. Las guardas de esquema/core se repitieron fuera de caché; catálogo,
97 migraciones sobre base virgen y todos los trinquetes quedaron verdes. Lint
conserva cuatro avisos existentes, sin errores. La suite de telemetría tiene
59 pruebas aprobadas, incluidas las 13 nuevas de redacción/transporte. No hubo
cambios de listas base ni del catálogo.

La revisión independiente detectó y comprobó la corrección de contraseñas entre
comillas con espacios y cuerpos HTTP anidados. No quedaron bloqueantes sobre
el código revisado. Collector recibió también la fixture final con esos casos:
mensajes request/job/drenaje y status 502, sin los contenidos ficticios omitidos.
Esta evidencia es local; CI remota y criterios externos no se dan por aprobados.

## Fuentes primarias

- [SDK logs JavaScript 0.54.2](https://github.com/open-telemetry/opentelemetry-js/tree/experimental/v0.54.2/experimental/packages/sdk-logs).
- [Exportador OTLP/protobuf 0.54.2](https://github.com/open-telemetry/opentelemetry-js/tree/experimental/v0.54.2/experimental/packages/exporter-logs-otlp-proto).
- [Modelo de logs OTLP](https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/logs/v1/logs.proto).
- [Configuración del Collector](https://opentelemetry.io/docs/collector/configuration/).
- [Release oficial del Collector 0.162.0](https://github.com/open-telemetry/opentelemetry-collector-releases/releases/tag/v0.162.0).
