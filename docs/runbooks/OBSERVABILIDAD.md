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

No necesita variables nuevas ni valores de ejemplo. Comprobar con GET `/health`
y `/ready` de cada servicio después de desplegar y registrar SHA de imagen,
fecha, estado HTTP y dependencias. Para workers y agents hacerlo dentro de la red
privada; no abrir puertos públicos para monitorearlos. Usar `/ready` en el smoke
posterior al deploy; `/health` por sí solo no comprueba que el usuario pueda operar.

## Evidencia pendiente para cerrar #17

1. Completar la sonda existente de los consumidores: actualmente workers/agents
   consultan Redis, pero sin `REDIS_URL` devuelven 200; workers tampoco acredita
   la base que necesita para el outbox. Corregir esos falsos positivos, limitar
   la espera y redactar errores antes de considerar completa la disponibilidad.
2. Un error controlado identificable de cada uno de los cinco servicios recibido
   en Sentry, sin datos personales ni contenido de conversaciones.
3. Una traza request → job con el mismo `trace_id`, recibida en Grafana; métricas
   y logs de plataforma recibidos en sus destinos, con `tenant_id` cuando aplica.
   Los tests con receptores locales no sustituyen esta comprobación externa.
4. Monitores activos de Uptime Kuma sobre API, agents y web. Registrar una caída
   controlada del monitor y su recuperación sin detener servicios compartidos.
5. Cuatro alertas configuradas y con prueba de entrega: error rate de API,
   latencia p95, cola atascada y disco sobre 80 %. Registrar umbral, ventana,
   destino y evidencia de recepción, sin publicar credenciales del destino.

La credencial de exportación debe ser válida en el gestor de secretos del
ambiente. No reemplazarla por un texto de ejemplo ni copiarla al repositorio o a
comentarios. Un valor incompleto de autorización OTLP sigue siendo un bloqueo
operativo aunque las sondas de disponibilidad estén verdes.

Las interrupciones durante recreación de contenedores se siguen en #254; las
sondas no convierten el despliegue Compose en uno sin cortes. El rol de base de
datos que omite RLS se sigue en #370 y tampoco queda corregido por este cambio.
