# Antes del primer despliegue a producción

Esta lista no es de buenas intenciones: cada punto está acá porque algo del
producto **se va a comportar distinto** si falta, y en varios casos sin decir
nada. El orden es el de las consecuencias, no el de la comodidad.

## 1. El rol de la aplicación (si falta, la API no sirve NADA)

La API en producción responde `503 SIN_AISLAMIENTO` a toda petición de datos
si la conexión puede saltarse las políticas por tenant. No es un
contratiempo del despliegue: es la única respuesta correcta cuando el
aislamiento entre clientes no está garantizado.

- Crear `iaxti_app` (`NOSUPERUSER NOBYPASSRLS`) y apuntar ahí el
  `DATABASE_URL` **de la aplicación**. El SQL completo está en
  [ROL-DE-LA-APLICACION.md](./ROL-DE-LA-APLICACION.md).
- En Supabase el rol `postgres` que entrega el panel **tiene BYPASSRLS**:
  pegarlo directo deja el producto sin aislamiento.
- Las migraciones siguen corriendo con el dueño, en su paso propio, antes del
  despliegue.

Comprobación: `SELECT current_user, rolsuper, rolbypassrls FROM pg_roles
WHERE rolname = current_user;` — las dos banderas en `false`.

## 2. `IAXTI_ENV=production` (si falta, tres cosas cambian en silencio)

- El **simulador** de conversaciones queda expuesto; con `production` no se
  registra siquiera (404, no 403).
- **HSTS** no se manda: detrás del túnel de Cloudflare el `x-forwarded-proto`
  llega como `http`, así que la cabecera depende de esta variable y no del
  protocolo.
- El **modo live de pagos** se rechaza fuera de producción a propósito. En
  producción se habilita: antes de eso, revisar que las credenciales sean
  las de verdad y estén por referencia.

## 3. Las credenciales, por referencia y rotadas

- Los canales y los pagos guardan el **nombre** de la variable de entorno,
  nunca el valor. Una credencial con `:` o `=` se rechaza a propósito.
- **Rotar todos los tokens** que hayan pasado por un chat durante la
  construcción. Sin excepción y antes de abrir a clientes.
- `AUDIT_EXPORT_SECRET` (firma de la exportación de audit): sin él la
  exportación sale sin firma, y lo dice, pero no sirve como evidencia.
- **Las cuatro de R2** —`R2_ENDPOINT`, `R2_ACCESS_KEY_ID`,
  `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_ADJUNTOS`— o **se pierden todos los
  adjuntos que entren**. Lo que manda el cliente por WhatsApp viene con una
  URL firmada y de vida corta del proveedor: se baja AL LLEGAR y se guarda en
  R2, y si R2 no está, el mensaje queda con esa URL y la URL vence. El dato no
  se recupera después.

  > No estaban en ningún runbook hasta #809, y el compose las interpola sin
  > `:?`, así que sin valor quedan en cadena vacía y nada falla al arrancar.
  > Encima `SECURITY_BASELINE.md` cuenta «los adjuntos de WhatsApp se
  > descargan al llegar» como control hecho, cuando depende de estas cuatro.
  > Hoy el worker al menos grita cuando no puede guardar uno; antes se caía
  > por fuera del `if` sin una línea de log.

## 4. El worker de tareas programadas TIENE que estar corriendo

De él dependen cosas que el negocio da por hechas. **Son diecisiete**, y la
lista vive en `apps/workers/src/main.ts` (`REPETIBLES`) — si acá dice otro
número, el que manda es el código:

| Tarea | Cada | Qué pasa si no corre |
|---|---|---|
| `billing.sweep` | 04:00 | la prueba gratis no termina, el impago no suspende, la cancelación no se hace efectiva |
| `conversations.retention` | 04:00 | los datos no se purgan según el plan (y eso es un compromiso legal) |
| `conversations.archive` | 03:00 | las conversaciones viejas no se archivan |
| `conversations.auto_resolve` | cada hora | las conversaciones resueltas quedan abiertas para siempre |
| `conversations.checks` | 1 min | los avisos de SLA y de conversación sin atender no salen |
| `crm.activities_due` | 1 min | las actividades vencidas no avisan |
| `crm.stalled` | 07:00 | las oportunidades estancadas no se marcan |
| `idempotency.sweep` | :20 | las llaves de reintento se acumulan para siempre |
| `automations.sweep` | 5 min | las reglas por tiempo ("2 días sin respuesta") no disparan |
| `api_usage.flush` | 5 min | el consumo de API no se cobra ni se muestra |
| `knowledge.reindex` | 5 min | la IA se queda sin el conocimiento que el negocio subió |
| `knowledge.expire` | :30 | las fuentes vencidas siguen contestando con datos viejos |
| `calendar.reminders` | 15 min | **nadie recibe el recordatorio de su hora** |
| `payments.expire` | :45 | los links de pago vencidos siguen cobrables |
| `whatsapp.templates.sync` | 30 min | el estado de aprobación de Meta no se entera |
| `webhooks.deliver` | 1 min | los webhooks salientes no salen |
| `analytics.response_samples` | :15 | el tiempo de primera respuesta no se mide |

**Comprobación:** en el log del worker tiene que aparecer, con el número y la
lista:

```
workers: worker de cola scheduled activo · 17 tareas programadas: conversations.checks, …
```

Y `GET /ready` del worker tiene que devolver `200` con `"startup": "ok"`. Si
los repetibles no quedaron programados, devuelve `503` y el campo `startup`
trae el motivo con los nombres que faltan.

> Hasta #807 esta comprobación no podía ver el fallo que existe para evitar.
> Mandaba a buscar dos líneas —`workers: despachador de outbox activo` y «las
> colas declaradas»— y las dos se imprimen igual con CERO repetibles
> programados: la primera unas cuatrocientas líneas antes de la programación,
> la segunda justo después y sin preguntar nada. La programación era un
> `void Promise.all([...]).catch(err => console.error(…))` sin `await`: si
> Redis tosía en el arranque, el error quedaba en un `console.error` entre
> cientos de líneas y el proceso seguía vivo diciendo «activo».
>
> Un operador que corriera la comprobación tal como estaba escrita concluía
> que las tareas estaban cubiertas. Y la tabla nombraba cinco de diecisiete,
> así que las otras doce no se echaban de menos.

## 5. WhatsApp: nunca el número real en un ambiente que no sea producción

El webhook apunta al ambiente donde se registró. Mientras el número de
producción no se reapunte, **los mensajes de clientes reales siguen llegando
a staging y nadie se entera** hasta que alguien reclama que no le
contestaron. Ver [DOMINIOS.md](./DOMINIOS.md).

## 6. Cloudflare

- Las reglas de rate limit tienen que estar acotadas por hostname: una regla
  global frena también los webhooks entrantes.
- Access delante del panel de Dokploy y del admin.

## 7. Después de desplegar, comprobar en este orden

1. `GET /health` → `200` (el proceso vive).
2. `GET /ready` → `200` y todas las dependencias en `ok`. Un `degraded` con
   `postgres ok:false` significa que la aplicación no alcanza la base: está
   "arriba" y no sirve para nada.
3. El log del arranque **no** dice `SIN AISLAMIENTO`.
4. Una conversación de prueba de punta a punta por el canal real.

## Por qué existe esta lista

Todo lo de acá salió de encontrarlo roto: el guardián de aislamiento porque
las políticas no se evaluaban, el `/ready` porque un `/health` en 200 tapaba
una base inalcanzable durante días, el barrido porque la mitad de la máquina
de estados no la caminaba nadie. Lo que está escrito es lo que ya nos pasó.
