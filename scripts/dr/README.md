# Derivado estructural local · #80

Esta herramienta conserva únicamente las relaciones de **12 tablas**:
`tenants`, `companies`, `contacts`, `tags`, `contact_tags`, `pipelines`,
`stages`, `loss_reasons`, `deals`, `conversations`, `messages` y `activities`.
No restaura las filas originales de las **otras 84 tablas**, ni los esquemas
Auth/Storage, auditoría, outbox, identidades, credenciales, archivos o trabajos
pendientes. Dos catálogos (`roles`, `plan_limits`) se reconstruyen con constantes
versionadas de una migración limpia; `platform_module_flags` y
`agent_task_defaults` quedan vacíos. Ninguna de esas filas viene del backup.

**No es anonimización integral de Supabase ni completa C3 de #80.** Conserva
cantidades y parte de la topología de relaciones; eso puede revelar estructura
y patrones. No certifica anonimato irreversible ni autoriza sacar el resultado
de cuarentena. No toma un backup remoto, no despliega, no configura cuentas y
no ejecuta el smoke. Se necesita revisión de privacidad, nuevas identidades
sintéticas/revinculación y archivos sintéticos antes de cualquier ensayo del
producto. Seguir el [checklist mensual](../../docs/runbooks/DR.md#staging-anonimizado-mensual).

## Compatibilidad reproducible

La rama de esta herramienta parte de `3114a5e` (continuación de PR955), cuya
base de producto `79936e77bfa57ebcfbcc16b81888af2fdb9983c7` tiene **97 migraciones**.
Ese esquema se rechaza con `DR_SCHEMA_UNSUPPORTED`; instalar esta herramienta
no aplica las 16 migraciones faltantes ni incorpora otras funciones al PR.

El [manifiesto](schema-113.json) corresponde al esquema de **113 migraciones,
96 tablas y 915 columnas** probado en el checkout local integrado `3eb93ac`.
Ese SHA local es procedencia de la prueba, no una rama publicada necesaria.
Las dependencias de esquema se pueden obtener de estos PR públicos, con sus
SHA fijados; antes de migrar una copia de ensayo deben estar integradas sus
migraciones y dependencias. No aplicar esta lista manualmente sobre producción.

| PR / SHA público | Migraciones adicionales respecto a 97 |
|---|---|
| [#928](https://github.com/voxtilabs/IAxTi/pull/928) · `8683f00` | `authorization/0004_membresias_de_la_sesion.sql` |
| [#929](https://github.com/voxtilabs/IAxTi/pull/929) · `be34fb2` | `payments/0005_suprimir_concepto_del_titular.sql` |
| [#941](https://github.com/voxtilabs/IAxTi/pull/941) · `a82ab56` | `knowledge/0005_borrados_de_archivo_pendientes.sql` |
| [#944](https://github.com/voxtilabs/IAxTi/pull/944) · `eb39b7e` | `organizations/0006_registro_inicial.sql`; `whatsapp/0009_partner_invitations.sql` |
| [#945](https://github.com/voxtilabs/IAxTi/pull/945) · `dbb32f2` | `calendar/0004_google_calendar.sql`, `0005_google_maintenance.sql`; `identity/0003_google_oauth.sql`, `0004_google_secret_intents.sql`, `0005_google_sweeps.sql` |
| [#946](https://github.com/voxtilabs/IAxTi/pull/946) · `00044cb` | `channels/0004_emisor_compartido.sql` |
| [#950](https://github.com/voxtilabs/IAxTi/pull/950) · `db65631` | `identity/0007_google_gmail.sql`; `integrations/0004_google_gmail.sql` |
| [#951](https://github.com/voxtilabs/IAxTi/pull/951) · `e09782b` | `identity/0006_google_services.sql`; `integrations/0003_google_drive.sql`; `crm/0011_anonymized_at.sql` |

Las rutas de la tabla parten de `packages/modules/`. El catálogo no se limita
al número de migraciones: compara columnas, tipos, defaults, claves/FK/checks,
índices, funciones, triggers y su estado, reglas, RLS/policies, secuencias,
enums y versiones de extensiones. Una variación requiere revisar/versionar el
manifiesto; **no regenerarlo automáticamente para aceptar una base desconocida**.
Auth/Storage se clasifican como omisión total sin leer sus filas; cualquier otro
esquema no interno se rechaza. El destino solo admite `public` más los esquemas
internos de PostgreSQL. No copia DDL desde el origen.

## Operación en cuarentena local

Node 22 y dependencias del repositorio (`pnpm install --frozen-lockfile`).
Solo acepta PostgreSQL en loopback, sin parámetros en la URL, con nombres
`iaxti_dr_*`. Las variables se cargan de manera privada; no escribir credenciales
en el historial, evidencias ni Git. No usar un túnel que apunte a producción.
El aislamiento de red de la copia y sus servicios sigue siendo responsabilidad
del operador: la CLI no administra firewall, extensiones ni procesos externos.

1. Preparar una copia de origen en cuarentena, sin consumidores ni salida de
   red, y una base **nueva** de destino con el esquema exacto soportado.
2. Configurar `DR_SOURCE_URL` para la copia de origen y `DR_TARGET_URL` para el
   destino distinto. El operador necesita lectura completa sin filtrado RLS,
   acceso a `pg_control_system()` y permisos de administración de la base de
   destino. Nunca es una conexión de aplicación. No modifica roles globales.
3. Con esas variables ya cargadas, ejecutar desde este checkout:

   ```sh
   node scripts/dr/cli.mjs export /ruta/privada/derivado.json
   node scripts/dr/cli.mjs import /ruta/privada/derivado.json
   ```

4. Conservar solo el resultado con conteos y checksum. El archivo se crea con
   modo **0600**, sin sobrescribir uno existente. Es data-only; no contiene SQL
   ejecutable ni un mapa de IDs originales. Import rechaza permisos abiertos,
   enlaces simbólicos, cambios de formato/checksum/valores y relaciones inválidas.
5. El destino queda **sin admitir conexiones** (`ALLOW_CONNECTIONS false`) y
   todos sus tenants suspendidos. La conexión de control a `postgres`, derivada
   de `DR_TARGET_URL`, confirma el cierre antes de cargar. Cualquier otra sesión
   cancela la operación; no se la termina a la fuerza. Si falla después del
   cierre, los datos revierten y el destino **permanece cerrado**. El operador
   debe revisar el fallo desde su conexión de administración; no se reabre solo.
6. La herramienta no habilita el destino. Antes de cualquier reapertura se
   requieren revisión, identidades sintéticas nuevas con sus vínculos, archivos
   sintéticos, configuración exclusivamente de ensayo, permisos/RLS y el smoke
   del runbook. No reutilizar cuentas, UUIDs externos, URLs o credenciales reales.

Export usa `REPEATABLE READ READ ONLY` y `row_security=off`: esto **no desactiva
RLS**; rechaza una lectura que sería filtrada, para evitar publicar un éxito
vacío. Solo selecciona claves UUID de las 12 tablas. Genera UUIDs nuevos y todos
los demás valores a partir de constantes/ordinales; no selecciona texto, JSON,
fechas, importes ni secretos originales. La nulabilidad de algunas relaciones
sí se conserva. Import valida origen/destino por identidad de clúster+base,
catálogo y destino vacío antes y después de cerrar admisión; mantiene triggers
y constraints activos y compara los valores persistidos con el manifiesto.

Límites: 50.000 filas totales y 50 MiB de artefacto, sentencia SQL de 10 s y
espera de lock de 2 s. Una copia mayor requiere otro desarrollo/revisión; no se
trunca silenciosamente. Los códigos de error son fijos, incluso ante un error
asíncrono de `pg.Pool`; no imprimen objetos de conexión. Los errores anteriores
al cierre no alteran destino; los posteriores conservan su cuarentena.

## Pruebas

Pruebas puras, también incluidas como paso de CI de esta rama:

```sh
node --test scripts/dr/transformer.unit.test.mjs
```

Prueba SQL separada: requiere un PostgreSQL 16 local **desechable**, roles que
exigen las migraciones del repo ya preparados, y un checkout de esquema 113
con `packages/db/dist/migrate.js` compilado. Configurar de forma privada
`DR_TEST_ADMIN_URL` apuntando a su base `postgres` y `DR_TEST_SCHEMA_ROOT`
apuntando a ese checkout; no al runtime. Ejecutar:

```sh
node --test scripts/dr/transformer.unit.test.mjs scripts/dr/transformer.sql.test.mjs
```

Crea bases `iaxti_dr_test_<aleatorio>_*`, aplica migraciones reales, inserta solo
marcadores ficticios y elimina únicamente esas bases. No lee un backup real ni
conecta proveedores. La prueba adicional de incompatibilidad usa las 97
migraciones de este checkout y exige rechazo explícito.

[Resultados y límites](../../docs/evidencias/80/transformer.md). Los tests SQL
sobre 113 migraciones se ejecutaron localmente; el CI de esta rama de 97 no
los suplanta con una simulación ni los declara aprobados remotamente.
