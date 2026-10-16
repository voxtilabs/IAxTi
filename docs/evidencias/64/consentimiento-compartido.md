# #64 · Consentimiento compartido con Calendar

Base: `11886265348c8880ebbc8619fd0d8cc58165f914` (#57). Esta evidencia
cubre el contrato OAuth compartido; no acredita todavía el recorrido Drive ni
una cuenta Google/GCP real. OAuth y Secret Manager están sustituidos en pruebas.
PostgreSQL, RLS, advisory locks, transacciones y auditoría son reales.

## Contrato

Un grant por negocio y usuario mantiene servicios acreditados y una referencia
única de tokens. Los intentos PKCE se distinguen por servicio. Los scopes
anteriores deben estar presentes en la respuesta efectiva del consentimiento:
un callback parcial o antiguo falla sin cambiar la conexión vigente. El refresh
comprueba los scopes de todos los servicios activos antes de sustituir la
versión. Calendar sigue siendo Base y no importa integrations.

`identity` recibe puertos OAuth, Secret Manager y auditoría. El runner reutiliza
el PoolClient del copiloto y toma el cerrojo de la cuenta sin esperar cuando ya
hay una transacción exterior. La revocación conserva las dos transacciones de
#57 y bloquea todos los servicios desde su primera confirmación durable.

## Verificación reproducible

Con PostgreSQL de pruebas y Redis aislados, desde la raíz:

```sh
pnpm exec turbo run build typecheck --filter=@iaxti/module-calendar...
pnpm exec turbo run test --filter=@iaxti/google --filter=@iaxti/module-identity --filter=@iaxti/module-calendar --filter=@iaxti/core
pnpm --filter @iaxti/module-calendar exec vitest run tests/google-services.test.ts
```

Suite conjunta antes de añadir la última regresión de carrera: Google 51,
identity 15, Calendar 121, core 348 correctas y 10 omitidas preexistentes.
Build/typecheck: 20 tareas correctas. La suite incremental ampliada tiene 10
pruebas correctas, incluida la carrera entre revocación y reconexión.

El crítico independiente encontró que leer un grant revocado y después borrar
la conexión sin bloqueo permitía borrar una reconexión concurrente. La prueba
intercepta únicamente la entrega de una lectura SQL real para forzar el orden:
lee revoked, confirma otro callback, retoma el consumidor. El consumidor relee
bajo `bloquearGrantGoogle({noEsperar:true})` y conserva la conexión activa. Un
control negativo quitando ese bloqueo falló por borrar la conexión nueva; el
producto quedó restaurado y la prueba correcta pasó. No se usaron sleeps.

Los consumidores de revocación no pueden asumir que un evento antiguo sigue
representando el estado vigente. Drive y los servicios posteriores deben usar
la misma barrera. Ninguna de estas pruebas acredita consentimiento externo,
permisos reales de Secret Manager, despliegue ni uso de una cuenta de Google.
