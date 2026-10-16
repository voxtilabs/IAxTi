# #57 · Conexión personal con Google Calendar

La implementación local está terminada y sometida a crítica independiente.
**No se declara completa la aceptación con Google real.** Las pruebas usan
PostgreSQL/RLS, HTTP y navegador reales con respuestas de Google sustituidas.
Faltan un proyecto autorizado, Secret Manager, cuenta de prueba y recepción
push en HTTPS público para acreditar el recorrido externo.

## Criterios originales

| Criterio | Implementación y prueba | Pendiente |
| --- | --- | --- |
| CalendarConnection por usuario; OAuth incremental, Secret Manager y revocación | Agenda solicita openid + calendar.events.freebusy al conectar; JWT humano, PKCE/state/nonce, ID token verificado, consumo único y secretos referenciados. SDK51 casos, HTTP y navegador. | Consentimiento y custodia en Google/GCP reales. |
| Disponibilidad por persona/equipo, días, horas, duración, buffer y anticipación | Mantiene disponibilidad existente y agrega autorización propia/equipo. USER no adquiere reservas ni recordatorios globales. Pruebas HTTP de denegación, RLS y permisos. | Validación del negocio con su equipo. |
| Horarios = free/busy real ∩ disponibilidad | Cliente de Calendar, zona del negocio, eventos que cruzan medianoche, buffer en instantes y caché breve invalidado. Fallos no se convierten en horas libres. | Cruce con eventos reales en cuenta autorizada. |
| Push, sin polling | Webhook de headers, token hash, recurso y vigencia; contador monotónico; cola y renovación de leases. El cron no consulta free/busy. | Recepción de Google y renovación en infraestructura pública. |
| Cada acceso a datos de Google en audit | Consulta, refresh fallido, watch, push, consentimiento y revocación tienen rastro; el copiloto comparte su transacción con el acceso. | Verificación del rastro en el recorrido externo. |

Citas nuevas y herramientas de reserva #58, recordatorios #59, Drive #64 y
Gmail #65 permanecen fuera del alcance. Calendar sigue siendo Base sin depender
de integrations/Crece. [ADR0027](../../adr/0027-consentimiento-personal-google.md)
y [configuración](../../configuracion/google-calendar.md) documentan los contratos.

## Correcciones de la revisión independiente

- Una intención de creación de secreto se confirma antes del acceso externo.
  El callback bloquea esa fila antes de crear el recurso; si el recolector ya
  la eliminó, el callback no crea nada. Se prueban ambos órdenes de la carrera.
- La revocación local `revoking` se confirma antes de llamar a Google. Un
  trigger que falla después del revoke remoto demuestra que el permiso no
  vuelve a `active` y que reconectar sigue bloqueado entre tenants.
- Los grants conocidos de la misma cuenta/cliente se revocan juntos, sin
  revelar otros negocios por la API. Un token ya inválido no omite los demás.
- El copiloto reutiliza su cliente de base: funciona con pool de una conexión
  y cerrojo de auditoría ya tomado. Si otra operación posee la cuenta, falla
  sin esperar, evitando inversión de cerrojos y sin inventar disponibilidad.
- Cambiar disponibilidad espera al cruce en curso y después invalida caché.
  Se reproduce un evento antes de medianoche y el aumento concurrente de buffer.
- La limpieza conserva cada fallo, continúa otras filas y negocios, y rota
  candidatos fallidos para alcanzar el número101 después de100 fallos.
  Las suites de barrido usan una base efímera propia para no consumir los
  recursos simulados de otras pruebas. Cada acceso SQL usa rol sin BYPASSRLS.

La limpieza conserva referencias incluso si una creación tuvo respuesta
incierta. Una versión cuyo alta terminó con timeout sin devolver referencia
se recoge al eliminar el recurso completo al reemplazar/revocar el grant;
no se afirma descubrir esa versión inmediatamente. La auditoría del copiloto
se confirma con la transacción de su invocador.

## Reproducción local

```sh
pnpm install --frozen-lockfile
pnpm antes-de-empujar --filter=@iaxti/google --filter=@iaxti/module-calendar \
  --filter=@iaxti/module-identity --filter=@iaxti/module-authorization \
  --filter=@iaxti/module-organizations --filter=@iaxti/module-agents \
  --filter=@iaxti/api --filter=@iaxti/web --filter=@iaxti/workers \
  --filter=@iaxti/agents --filter=@iaxti/sdk
pnpm --filter @iaxti/web exec node e2e/run-google.mjs
```

Requiere PostgreSQL y Redis aislados; las fixtures migran con el rol dueño y
la aplicación usa un rol sin superusuario ni BYPASSRLS. El arnés del navegador
usa puertos4027/4028/4029 y una base separada. El servidor de consentimiento y
las respuestas OAuth, Calendar y Secret Manager se sustituyen explícitamente;
no hay cuentas ni envíos externos.

Evidencia de navegador: dos recorridos día/noche a360px, ocho PNG en este
directorio. Comprueban callback, revocación, permiso propio, ausencia de acciones
no concedidas, error persistente con rastro, reintento, teclado/foco y contraste
computado del enlace >=4.5. El texto del botón de revocación queda dentro del control.

Los endpoints personales se excluyen del catálogo de herramientas de IA.
El webhook es un consumidor externo declarado; las rutas SDK se generan desde
OpenAPI. La limpieza se ejecuta como trabajo de identidad aunque Calendar se
apague; deben conservarse sus variables e identidad de servicio hasta terminar
los pendientes. La selección SQL visita únicamente tenants con trabajo.

Preflight final: **2031 aprobadas, 14 omitidas, 0 fallos**; typecheck36 tareas, build29 y102 migraciones sobre base virgen. Incluye38 casos nuevos SQL/RLS de Google/limpieza,51 de SDK y479 de API (más4 omitidos existentes). La guarda de columnas exigió ordenar el baseline con su generador; se corrigió y el preflight completo quedó verde. Las cuatro advertencias de lint existentes no se ocultaron.

Capturas: [conexión día](google-dia-360-desconectado.png) · [conexión noche](google-noche-360-desconectado.png) · [callback día](google-dia-360-callback.png) · [callback noche](google-noche-360-callback.png) · [revocación día](google-dia-360-revocar.png) · [revocación noche](google-noche-360-revocar.png) · [error día](google-dia-360-error.png) · [error noche](google-noche-360-error.png).
