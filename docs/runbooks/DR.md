# Runbook · recuperación ante desastres (DR)

Un backup que nunca se restauró no es un backup. Los compromisos de la
sección 15 del SPEC —**RPO 5 minutos, RTO 1 hora**— se demuestran corriendo
esto, no declarándolos.

Cada simulacro se anota en [`RESULTADOS-DR.md`](RESULTADOS-DR.md), con
tiempos reales. **Una desviación del compromiso abre un issue**: la
desviación que no se registra se repite.

## Qué se ensaya y cada cuánto

| Simulacro | Frecuencia | Compromiso | Quién |
|---|---|---|---|
| Rollback de release | en cada release mayor, y mensual | < 2 min | automatizado (`rollback.yml`) |
| Restore de Postgres a un punto en el tiempo | mensual | RPO < 5 min · RTO < 1 h | a mano, con el panel de Supabase |
| Restore de Redis desde R2 | mensual | RTO < 15 min | a mano |
| Staging desde backup de producción anonimizado | mensual | medir RPO/RTO; checklist §6 | operador y revisor del ensayo |
| VPS completo en un servidor limpio | trimestral | RTO < 1 h | a mano |

## 1. Rollback de release (automatizado)

```
Actions → rollback → Run workflow
  tag: vX.Y.Z (o el SHA del commit; las imágenes se publican con ambos)
  ambiente: staging | production
  motivo: qué se está arreglando
```

El workflow **lee el entorno actual y cambia solo la línea `IMAGE`**. Esto
no es un detalle: el campo `env` de Dokploy es el bloque completo, y
mandarlo con una sola línea borra `DATABASE_URL`, `REDIS_*`, `SUPABASE_*` y
el resto — justo cuando hace falta que la app vuelva. La versión anterior de
este workflow tenía ese bug (#80).

Al terminar, el resumen de la corrida trae **de dónde, a dónde y cuántos
segundos tardó**, y avisa si se pasó de los 120 s.

El rollback es **solo de imagen, nunca de base**. Funciona porque las
migraciones son aditivas (SPEC §27): la versión anterior corre contra el
esquema nuevo sin enterarse. Si alguna vez una migración deja de ser
aditiva, este runbook deja de ser cierto y hay que reescribirlo.

## 2. Restore de Postgres (PITR de Supabase)

1. Anota la hora exacta a la que quieres volver, y **por qué**.
2. Panel de Supabase → Database → Backups → Point in Time → elige el
   instante. Arranca el cronómetro.
3. Supabase restaura sobre el mismo proyecto. Cuando termine, anota el reloj.
4. Verifica con datos, no con el panel:
   - `SELECT count(*) FROM messages WHERE created_at > <instante - 10 min>`
   - la última conversación de la bandeja abre y muestra sus mensajes
   - `pnpm run migrate:deploy` dice "Migraciones al día"
5. Registra RPO real (cuánto se perdió) y RTO real (cuánto tardó) en
   `RESULTADOS-DR.md`.

> **Lo que se pierde y nadie recuerda:** las colas de BullMQ viven en Redis,
> no en Postgres. Un restore de la base a un punto anterior deja jobs
> encolados que hablan de filas que ya no existen. Después del restore,
> revisar la cola `inbound` y descartar lo que apunte a ids desaparecidos.

## 3. Restore de Redis desde R2

1. Baja el último `dump.rdb` del bucket de backups.
2. Detén el servicio de Redis en Dokploy, reemplaza el volumen, levanta.
3. Verifica: `redis-cli LLEN bull:inbound:wait` y que un mensaje entrante
   nuevo llegue a la bandeja.

Lo que se pierde es lo que Redis tuviera en memoria desde el último RDB —
por eso el snapshot va cada hora y las colas son idempotentes por id.

## 4. VPS completo en un servidor limpio

1. Servidor nuevo, Docker y Dokploy instalados.
2. Importar `infra/dokploy/docker-compose.prod.yml` desde el repo.
3. Cargar las variables del proyecto (Dokploy no las respalda: **viven en el
   gestor de secretos, y si solo viven en el panel, este paso no se puede
   completar**).
4. Apuntar el túnel de Cloudflare al servidor nuevo.
5. Cronometrar hasta que `/health` responda 200 y un mensaje entrante llegue
   a la bandeja.

## 5. La prueba que de verdad cierra cualquier simulacro

`/health` dice que el proceso está vivo. Lo que dice que el **producto**
funciona es un mensaje entrante que llega a la bandeja y una respuesta que
sale. Ningún simulacro se da por bueno sin eso.

<a id="staging-anonimizado-mensual"></a>

## 6. Staging desde producción anonimizada · checklist mensual (#80, C3)

Copiar esta lista en el registro de cada mes y completar responsable, fecha y
evidencia de cada paso. La rutina viene de SPEC §36–37; se registra en
[`RESULTADOS-DR.md`](RESULTADOS-DR.md). **Esta lista no acredita un restore**:
el ensayo, sus tiempos y la anonimización efectiva siguen pendientes hasta
ejecutarse y verificarse.
La [plantilla del registro mensual](../evidencias/80/README.md#registro-mensual)
deja separados los datos del ensayo y la documentación todavía sin ejecutar.

El repositorio no incluye todavía un script de anonimización integral para
este restore. `redactPII` y la supresión de un contacto no cubren una copia
completa de producción. Antes de ejecutar, debe existir un transformador
versionado, revisado contra el esquema del backup y probado con datos
sintéticos. Registrar su SHA y sus verificaciones; si falta, dejar el ensayo
pendiente en lugar de importar datos reales en staging.

### A. Preparar el ensayo y separar destinos

- [ ] Anotar mes, operador, revisor, ventana y siguiente fecha mensual.
  Identificar el backup autorizado de producción, su formato, tamaño,
  checksum, instante recuperable y versión de esquema. Anotar el punto de
  recuperación objetivo antes de empezar, no elegirlo después del resultado.
- [ ] Identificar por proyecto, host y base los tres destinos: origen de solo
  lectura, copia temporal en cuarentena y staging. Verificar que son distintos
  antes de cualquier comando de escritura. Este checklist no ejecuta el PITR
  sobre el proyecto de producción descrito en §2.
- [ ] Comprobar acceso al backup, capacidad de disco y herramienta compatible
  con su formato. Guardar el comando de restauración usado, con credenciales
  redactadas; no suponer que un respaldo físico se importa como un dump SQL.
- [ ] Preparar una copia temporal restringida y sin salida a terceros. Mantener
  apagados API, web, admin, workers, agentes y servicios de Auth que pudieran
  enviar correo. Impedir también salidas de jobs/extensiones de la propia base.
  No configurar servicios con credenciales operativas de producción. Los
  secretos que contenga el backup permanecen inaccesibles fuera de la cuarentena
  hasta excluirlos del derivado.
- [ ] Reservar la ventana de staging y coordinar despliegues automáticos para
  que no arranquen consumidores durante la preparación. Resguardar el estado
  previo de staging y anotar cómo volver a él si falla la validación.
  **No asumir que staging solo contiene datos ficticios**: la excepción de Zavu
  está documentada en las reglas de seguridad y ADR-0011.

### B. Restaurar y anonimizar dentro de la cuarentena

- [ ] Registrar `t_inicio` y restaurar el backup exclusivamente en la copia
  temporal. Registrar `t_restore` y cualquier error; no continuar con una
  importación parcialmente fallida. Conservar el backup original sin modificar.
- [ ] Comparar el esquema recuperado con
  [`INVENTARIO-DATOS.md`](../INVENTARIO-DATOS.md) y las migraciones de su versión.
  Inventariar **todas** las tablas/columnas, también las que no tienen
  `tenant_id`, esquemas Auth/Storage, JSON, texto libre y referencias externas.
  El test del inventario por tenant es un apoyo, no prueba anonimización.
- [ ] Aplicar el transformador revisado en la copia temporal. Su registro de
  cobertura debe especificar, por tabla/columna, qué se sustituye por datos
  sintéticos, qué se omite del artefacto derivado y cómo se conservan las FK.
  Ninguna columna desconocida se considera segura por omisión.
- [ ] Comprobar como mínimo estas superficies, incluyendo las tablas nuevas
  del esquema realmente restaurado:

  | Superficie | Comprobación del artefacto que puede llegar a staging |
  |---|---|
  | Contactos, empresas, equipo y negocio | Sin nombres, correos, teléfonos, RUT, identidades de canal, direcciones ni campos libres originales; sin correspondencias de reidentificación en el artefacto. |
  | Mensajes, notas, actividades, propuestas y ejecuciones IA | Contenido y metadata sustituidos u omitidos; sin prompts, respuestas, transcripciones o extractos originales. |
  | Conocimiento y adjuntos | Documentos, chunks, embeddings y cachés derivados revisados; sin bytes, claves R2 ni URLs de archivos de producción. Para el smoke se usan archivos sintéticos en el bucket de staging. |
  | Auth, membresías e invitaciones | Solo identidades de prueba de staging y relaciones coherentes; sin sesiones, contraseñas, tokens de invitación ni suscripciones push de producción. |
  | Integraciones y credenciales | Sin API keys utilizables, referencias a secretos de producción, grants OAuth, endpoints de terceros, números o cuentas de cobro reales activos. No revocar credenciales de producción para limpiar su copia. |
  | Trabajo pendiente | Sin eventos outbox, jobs, campañas, secuencias, recordatorios, entregas o claves/respuestas de idempotencia capaces de repetir efectos de producción. |
  | Auditoría y soporte | Revisar actor, metadata, IP y contenido. No alterar ni recalcular la cadena histórica para presentarla como original. El transformador debe excluir datos personales del derivado y documentar esa exclusión; el backup original conserva su evidencia. |

- [ ] Validar automáticamente la cobertura y los invariantes del derivado
  (FK, unicidad, pertenencia al tenant, relaciones de identidades de prueba).
  Probar con marcadores sintéticos que detecta PII residual y referencias
  externas; registrar solo cantidades/resultados, nunca los valores hallados.
  Una búsqueda de correos/teléfonos por sí sola no demuestra anonimización.
- [ ] Revisar una muestra en cada superficie y confirmar que no queda contenido
  identificable ni una ruta a archivos o credenciales de producción. Si una
  comprobación falla, mantener la cuarentena y registrar el fallo; no abrir
  staging ni enviar la muestra a observabilidad o a un proveedor IA.
- [ ] Producir un artefacto derivado anonimizado con checksum y manifiesto de
  exclusiones/transformaciones. Registrar `t_anonimizado` y la revisión. Solo
  este artefacto puede salir de la cuarentena hacia staging.

### C. Cargar staging y verificar el producto

- [ ] Con consumidores y entrada externa detenidos, restaurar el derivado en
  el destino de staging identificado en A. Registrar `t_importado`, conteos y
  checksum del artefacto utilizado. Mantener separadas las credenciales del
  migrador y de la aplicación.
- [ ] Configurar únicamente recursos del ensayo/staging: Supabase Auth,
  Redis, R2, URLs de retorno, canales de prueba y proveedores permitidos para
  datos sintéticos. Verificar el entorno efectivo con `IAXTI_ENV=staging`;
  no falsearlo como producción para eludir controles.
- [ ] Usar una instancia o espacio Redis limpio y propio del ensayo, sin
  restaurar colas/cachés de producción junto al derivado anonimizado. La
  recuperación real de Redis se mide por separado en §3; no contar este paso
  como una restauración de su backup. Comprobar además que el outbox SQL no
  pueda reconstruir trabajos de producción al iniciar workers.
- [ ] Anotar el SHA completo de la imagen de staging y aplicar las migraciones
  aditivas antes del despliegue. Seguir
  [`ROL-DE-LA-APLICACION.md`](ROL-DE-LA-APLICACION.md) para crear/verificar el
  rol limitado; ejecutar su comprobación de permisos con ese rol. Fallar si
  tiene `SUPERUSER`, `BYPASSRLS` o le faltan permisos.
- [ ] Verificar en SQL y con dos identidades sintéticas que un tenant no lee
  ni modifica objetos del otro, que un usuario sin permiso recibe rechazo y
  que el login pertenece al proyecto Auth de staging. No usar el dueño de la
  base como evidencia de aislamiento.
- [ ] Arrancar los cinco servicios solo después de las comprobaciones
  anteriores. Verificar salud/readiness, login y creación de contacto de
  prueba. Enviar un mensaje sintético por webchat, verlo en la bandeja,
  obtener sugerencia y confirmar una respuesta recibida en ese mismo cliente
  de prueba. Registrar IDs de prueba y tiempos, sin contenido de clientes.
- [ ] Revisar colas, audit y logs del ensayo: sin errores de permiso, efectos
  de eventos antiguos, envíos/cobros reales ni acceso a recursos de producción.
  Registrar `t_verificado` solo si todas las comprobaciones pasaron.

### D. Registrar resultado, desvíos y limpieza

- [ ] Completar en `RESULTADOS-DR.md` el mes, responsables, origen/destino sin
  secretos, SHA de imagen/transformador, checksums, exclusiones y evidencia de
  los pasos anteriores. Mantener los tiempos fallidos; no reemplazarlos por
  los de un reintento exitoso.
- [ ] Registrar el tiempo completo `t_verificado - t_inicio` y, por separado,
  restore, anonimización, importación y smoke. Comparar con **RTO 1 h** sin
  descontar etapas silenciosamente. Si no se llegó al smoke final, registrar
  duración hasta el fallo y RTO **no demostrado**.
- [ ] Medir el punto realmente recuperado en la copia aislada **antes** de
  transformar fechas/datos: último hito confirmado recuperado frente al punto
  objetivo acordado. Registrar su diferencia como pérdida observada y
  compararla con **RPO 5 min**. Si el backup o la evidencia no permiten medirlo,
  escribir **RPO no demostrado**; la edad del archivo no prueba el RPO.
- [ ] Registrar las desviaciones conforme a la regla de este runbook y enlazar
  su seguimiento. No marcar #80 completa por publicar este checklist ni por
  un smoke local: los ensayos PITR, Redis, VPS y sus tiempos siguen separados.
- [ ] Si falló la importación o el smoke, mantener detenidos los consumidores
  del ensayo y volver al estado previo de staging por el procedimiento anotado
  en A; comprobarlo antes de devolver el ambiente al equipo. Nunca revertir
  producción ni borrar su backup como parte de esta limpieza.
- [ ] Eliminar las copias temporales, archivos descargados y correspondencias
  de transformación del ensayo al terminar su revisión; comprobarlo y registrar
  el resultado, sin cambiar la retención del backup original. Conservar solo
  el informe sin PII, sus hashes y los enlaces a evidencia de acceso restringido.
  Anotar la próxima fecha mensual y el responsable.
