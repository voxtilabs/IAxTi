# Configurar Flow de forma gradual · #366 / #60

El archivo `.env.example` es una plantilla para el operador; la aplicación
no lo carga automáticamente. El único default de Flow es su URL sandbox.
Las credenciales quedan vacías mientras se gestionan con el proveedor:
un intento de cobro sin ellas devuelve un error de configuración y no crea
un link. Esto no impide arrancar API, workers ni otros módulos.

1. Obtener una cuenta y credenciales de **Flow Sandbox**. La documentación
   oficial distingue [credenciales y destinos por ambiente](https://developers.flow.cl/docs/intro).
2. Guardar `apiKey:secretKey` en el gestor de secretos del despliegue, bajo
   una referencia propia del negocio. `IAXTI_FLOW_SANDBOX_CREDENTIALS` en el
   ejemplo es un nombre ilustrativo, no una llave global para todos los tenants.
3. Exponer esa referencia al entorno de API y workers. Guardarla en Dokploy
   no basta: ambos servicios deben recibirla mediante su configuración de
   entorno/secretos. Los compose actuales no pasan nombres arbitrarios;
   la referencia elegida debe agregarse a su configuración del despliegue.
4. Registrar el proveedor con `kind=flow`, `mode=test` y `credentialRef`
   igual al nombre elegido. La base guarda el nombre, nunca el valor.
5. Mantener `FLOW_API_BASE=https://sandbox.flow.cl/api` y confirmar que
   `PUBLIC_API_URL` corresponde a staging. Hacer el recorrido real de #60:
   crear link, pagar en sandbox, recibir confirmación y comprobar estado,
   auditoría e idempotencia. Esa prueba requiere credenciales del proveedor.

La validación se aplica tanto al crear un link como al consultar su estado.
Un registro test no puede usar la URL live, tampoco dentro de producción.
Live exige `IAXTI_ENV=production` y la URL oficial live configurada de forma
explícita. URLs arbitrarias, HTTP, queries y redirecciones se rechazan antes
de mandar credenciales; valores de ejemplo conocidos también se rechazan.
Una llave con formato aceptado todavía puede ser inválida: solo Flow puede
confirmar su vigencia. No se promete detección de cualquier texto ficticio.

La URL sigue siendo configuración por despliegue. No se habilitan cuentas
test y live simultáneas en un mismo despliegue con destinos distintos.
Activar producción, custodiar credenciales y cobrar dinero real son pasos
posteriores a esta protección y a la validación del sandbox.

## Evidencia y criticidad

Riesgo alto: destino de credenciales y cobros. Este PR es una protección
separada de #60; **no cierra** la integración con el proveedor.

Pruebas sin llamadas ni cobros externos: 20 casos de configuración y adaptador,
tres casos con Postgres real para creación/worker, ausencia de links/audit/outbox
al rechazar y petición firmada al destino esperado con redirecciones prohibidas.
Las respuestas HTTP de Flow son simuladas; su sandbox real sigue pendiente.
