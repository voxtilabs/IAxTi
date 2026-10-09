# ADR 0026 · Preguntar una vez quién tiene trabajo, en vez de recorrer a todos

**Estado:** aceptada · 2026-10-09 · se apoya en la
[ADR-0008](0008-modelo-de-autorizacion.md) y corrige una consecuencia de
[#286](https://github.com/voxtilabs/IAxTi/issues/286)

## Contexto

`sweepBilling` recorre **todos** los tenants vivos, uno por uno, y por cada uno
abre una transacción y corre los seis pasos del ciclo. Eso fue deliberado: #286
descubrió que los barridos globales —un `SELECT ... FROM subscriptions` suelto al
pool— devuelven **cero filas** con el rol de producción, porque esas tablas
tienen RLS y una consulta fuera de `withTenant` corre sin `app.tenant_id`. En
desarrollo no se veía, porque el rol es superusuario y Postgres ni mira las
políticas.

El arreglo fue correcto y la forma, costosa. Medido el 09/10 en una base local
con 1.232 tenants (acumulados por las suites de prueba):

| | |
|---|---|
| Visitar un tenant **sin trabajo** | 4,5 ms (una transacción + 5 consultas) |
| Los 1.232 de esta base | **~5,5 s** |
| Proyectado a 1.000 tenants | ~4,5 s |
| Proyectado a 1.000 tenants con la base a 64 ms de distancia ([#711](https://github.com/voxtilabs/IAxTi/issues/711)) | **~10 minutos** |
| Preguntar **una vez** quién tiene trabajo | **2 ms** |

El síntoma visible fue otro: la suite de `billing` tiene pruebas rojas en local y
verdes en CI ([#580](https://github.com/voxtilabs/IAxTi/issues/580)). No era
contención ni una consulta lenta — era el barrido recorriendo mil doscientos
tenants de prueba. Y la pregunta que dejó escrita ese issue es la que importa:
si tarda cinco segundos con un puñado, ¿cuánto tarda con mil?

La respuesta, con la base donde está hoy, es **diez minutos de un cron haciendo
nada**.

## Decisión

El barrido **pregunta primero quién tiene trabajo** y solo visita a esos. La
pregunta es una función `SECURITY DEFINER` —`tenants_con_trabajo_de_facturacion()`—
porque la condición cruza `subscriptions` e `invoices`, que tienen RLS, y el
tenant es precisamente lo que se está averiguando.

Es el **segundo** agujero de este tipo en el sistema; el primero es
`resolver_api_key` (#286), y su migración dice «es el único». Esa frase deja de
ser cierta, así que esta decisión queda escrita acá en vez de en un comentario.

Se acota con el mismo criterio que la primera:

- **Sale una lista de ids de tenant y nada más.** Ni montos, ni estados de
  suscripción, ni nombres. `tenants` no tiene RLS, así que esos ids ya son
  visibles para el rol de la aplicación: lo único que agrega la función es
  *cuáles de ellos tienen trabajo de facturación pendiente*.
- **No acepta parámetros.** No se puede usar para preguntar por un tenant ajeno
  ni para recorrer nada: devuelve lo que devuelve.
- **`SET search_path = public`**, para que quien controle el search_path no pueda
  hacer que la función llame a otra cosa.
- **El `EXECUTE` se concede explícitamente** al rol de la aplicación, no a PUBLIC.
- El barrido sigue entrando a cada tenant **con `withTenant`**. La función decide
  *a quién visitar*; todo lo que se lee y se escribe sigue pasando por RLS. Si la
  función se equivocara y devolviera un tenant de más, el paso correspondiente no
  encontraría trabajo y no haría nada.

## Enmienda · 09/10, al aplicar el patrón a los otros dos barridos (#733)

`barrerRecordatorios` y `sweepTimeRules` tenían el mismo problema y se
arreglaron igual, con una función cada uno en su módulo —`calendar` y
`automations`— porque la condición de «quién tiene trabajo» la conoce su dueño.
Son tres funciones `SECURITY DEFINER` en total, todas de la misma forma: salen
ids y nada más.

Y hay una diferencia que esta ADR no previó: **la de recordatorios SÍ acepta un
parámetro**, el instante de referencia. El barrido acepta un reloj inyectado para
poder probarse, y con `now()` en el SQL el filtro y la regla **discrepaban**: el
barrido no veía al tenant que sí tenía una cita para su reloj. Lo cazó una
prueba, y tenía razón — un filtro que solo acierta en producción es la clase de
cosa que después nadie entiende.

El argumento de «no acepta parámetros» se sostenía en que así no se puede
preguntar por otra cosa. Vale para la de facturación, que no lo necesita. Para la
de recordatorios el parámetro no abre nada que el rol de la aplicación no pudiera
ya: **ese rol fija `app.tenant_id` él mismo en cada transacción**, así que RLS lo
protege de errores y de inyección, no de sí mismo. La acotación que de verdad
sostiene las tres es la otra: sale una lista de ids, y los ids ya son visibles
porque `tenants` no tiene RLS.

## Consecuencias

- El cron de facturación pasa de O(tenants) a O(tenants con trabajo). Con mil
  tenants y una docena con ciclo vencido, de ~10 minutos a menos de un segundo.
- Hay un segundo `SECURITY DEFINER` que auditar. Las dos funciones viven en
  migraciones, se leen en dos archivos, y ésta no acepta argumentos.
- La suite de `billing` deja de depender de cuántos tenants dejaron las otras
  suites en la base. Eso no era un detalle de comodidad: una suite roja en local
  enseña a ignorar el rojo, y esta noche el rojo fue información cuatro veces.
- **No se toca** la decisión de #286. Los barridos siguen sin leer tablas con RLS
  desde fuera de `withTenant`; lo que cambia es que ya no hace falta visitar a
  todos para saberlo.

## Alternativas descartadas

**Subir el `testTimeout` y seguir.** Es lo que habría escondido la pregunta del
issue. El timeout era el mensajero.

**Una columna en `tenants` que marque «tiene trabajo».** Es el defecto que
venimos sacando toda la semana —declarado en un lado, aplicado en ninguno— con el
agravante de que quien escribe el trabajo tendría que acordarse de marcarla.

**Un rol con `BYPASSRLS` para el cron.** Convierte un agujero acotado y auditable
en uno general. Y #370 está abierto justamente para quitarle `BYPASSRLS` al rol
de staging.

**Procesar los tenants en paralelo.** Multiplica el rendimiento por el tamaño del
lote y no cambia el orden de magnitud: mil tenantes sin trabajo siguen costando
mil transacciones. Sirve *después* de esto, si hace falta.
