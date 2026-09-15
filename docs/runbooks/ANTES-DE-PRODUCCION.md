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
- `IAXTI_AUDIT_SECRET` (firma de la exportación de audit): sin él la
  exportación sale sin firma, y lo dice, pero no sirve como evidencia.

## 4. El worker de tareas programadas TIENE que estar corriendo

De él dependen cosas que el negocio da por hechas:

| Tarea | Qué pasa si no corre |
|---|---|
| `billing.sweep` | la prueba gratis no termina, el impago no suspende, la cancelación no se hace efectiva |
| `conversations.retention` | los datos no se purgan según el plan (y eso es un compromiso legal) |
| `idempotency.sweep` | las llaves de reintento se acumulan para siempre |
| `automations.sweep` | las reglas por tiempo ("2 días sin respuesta") no disparan |
| `api_usage.flush` | el consumo de API no se cobra ni se muestra |

Comprobación: en el log del worker tiene que aparecer `workers: despachador
de outbox activo` y las colas declaradas.

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
