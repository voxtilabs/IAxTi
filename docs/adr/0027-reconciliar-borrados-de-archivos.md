# ADR 0027 · Reconciliar borrados mirando el archivo, sin volver a borrarlo

**Estado:** propuesta · 2026-10-16 · #751

## Contexto

Morir entre DELETE en R2 y COMMIT deja una fuente activa sin archivo. Una
intención antigua también puede pertenecer a un DELETE todavía activo: su edad
no demuestra que haya terminado. Pedir otra conexión mientras se retiene una
transacción puede agotar el pool; un lock de sesión no sirve con el pooler en
modo transacción.

## Decisión

`eliminarFuente` confirma la intención en una transacción propia antes de R2.
En otra transacción toma el lock del archivo, relee la intención y recién
entonces borra. Si la intención desapareció en el intervalo, vuelve a crearla
sin tocar R2 (hasta tres intentos). El lock es advisory transaccional por tenant
+ key; las eliminaciones de fuentes compartidas usan el mismo lock.

El barrido toma ese lock sin esperar: un DELETE activo queda para otra pasada.
Relee intención y fuente y hace HEAD: 404 marca `delete_failed`, 2xx conserva el
estado actual y limpia la intención; errores conservan el pendiente. Nunca
borra objetos. Si la fuente ya no existe, solo limpia el registro. La marca y
su auditoría comparten transacción. El selector devuelve únicamente ids de
negocios con pendientes, siguiendo ADR-0026; cada negocio se procesa bajo RLS.

## Consecuencias

El proceso puede morir entre cualquiera de las transacciones sin perder la
evidencia de un archivo destruido. Cuesta una transacción adicional, un HEAD
por pendiente antiguo y una tabla con RLS sin FK a sources. El barrido es
idempotente, cada cinco minutos, con 100 registros por negocio y pasada.
Un claim breve con `FOR UPDATE SKIP LOCKED` persiste `last_attempted_at` y
libera la conexión antes del lock de archivo. El siguiente lote prioriza lo
menos intentado: 100 HEAD desconocidos no esconden al registro 101. El claim
no modifica la antigüedad original y también rota filas ocupadas/omitidas.

El procesamiento toma el lock de la fuente antes de leer su estado y no
reprocesa `delete_failed`: el barrido omite fuentes ocupadas y conserva su
intención, evitando una reactivación tardía. Las intenciones confirmadas de
fuentes ya eliminadas también se limpian sin HEAD.

### Límite preexistente: altas con una key compartida

Se conserva el archivo mientras otra fuente confirmada lo usa, y se serializan
borrados concurrentes de esas fuentes. No se garantiza un alta concurrente que
reutiliza la misma key: el alta puede haber descargado bytes antes del borrado y
confirmarse después. Cerrar esa carrera requiere validar la existencia bajo la
misma coordinación o impedir reutilizar keys; queda fuera de la recuperación
de borrados interrumpidos de #751 y no se promete resuelto por este lock.

## Se revisa cuando

Cambie `r2_key` de fuentes existentes, se reutilicen keys eliminadas o el volumen
de pendientes requiera repartir el barrido por negocio.
