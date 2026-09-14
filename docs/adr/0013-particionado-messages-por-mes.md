# ADR-0013 · Particionado de `messages` por rango mensual

- **Estado**: propuesto (needs:decision — #84)
- **Fecha**: 2026-09-14
- **Condición de activación**: `messages` supera ~20 millones de filas
  (hoy estamos a órdenes de magnitud de eso: es una condición, no una
  tarea inmediata).

## Contexto

`messages` es la tabla que crece sin techo: cada entrante y saliente de
cada tenant. Dos costos aparecen con el volumen:

1. La **retención** (#77) borra por `DELETE ... WHERE last_message_at <
   corte` en lotes — correcto hoy, pero con decenas de millones de filas
   ese DELETE paga I/O, bloat y vacuum.
2. Los índices calientes de la bandeja (`conversation_id, seq`) crecen
   con la historia completa aunque la bandeja solo mira lo reciente.

## Decisión propuesta

Particionar `messages` **por rango mensual sobre `created_at`**, con
`pg_partman` descartado (dependencia extra en Supabase) a favor de un
job propio en la cola `scheduled` que crea la partición del mes
siguiente con anticipación (idempotente, como los demás sweeps).

### Migración en dos pasos, sin ventana de corte

1. **Paso 1 (transparente)**: crear `messages_particionada` (misma
   definición, `PARTITION BY RANGE (created_at)`) con particiones desde
   el mes más viejo con datos; backfill por lotes de 50k con
   `INSERT ... SELECT` ordenado por `created_at` fuera de horario punta;
   trigger en `messages` que replica INSERT/UPDATE al espejo durante el
   backfill (el mismo patrón dual-write de cualquier migración caliente).
2. **Paso 2 (corte lógico)**: en una transacción corta,
   `ALTER TABLE messages RENAME TO messages_vieja` +
   `ALTER TABLE messages_particionada RENAME TO messages`; el trigger
   muere con la vieja; `messages_vieja` se conserva una semana y se
   dropea. El código no cambia: mismo nombre, mismas columnas, mismos
   índices (declarados por partición).

### Lo que cambia y lo que no

- La **retención** pasa de DELETE por lotes a `DROP PARTITION` de los
  meses anteriores al corte — I/O cero, vacuum cero. El CONTRATO se
  mantiene: las llaves R2 se leen antes (por partición completa), la
  entrada de audit por tenant y corrida sigue igual (el conteo sale de
  `pg_class.reltuples` de la partición antes del drop, o de un COUNT
  barato por partición), y `new/open/snoozed` viejas se MUEVEN a la
  partición vigente antes del drop (son poquísimas por definición).
- Los índices se declaran en la tabla madre y Postgres los materializa
  por partición: los de la bandeja quedan chicos (solo meses recientes
  en cache).
- `seq` (bigserial) sigue global: el orden dentro de la conversación no
  depende de la partición.
- RLS: la política vive en la madre y aplica a todas las particiones
  (Postgres 15+). FORCE igual que hoy.

## Alerta del umbral (se implementa AL APROBAR este ADR)

Job mensual en `scheduled`: `SELECT reltuples::bigint FROM pg_class
WHERE relname = 'messages'` → si supera 15M (margen antes de los 20M),
notificación `cuota_ia`-style al SUPERADMIN y evento al outbox. La
métrica de tamaño de base ya existe en Grafana; esto agrega el aviso
accionable.

## Alternativas descartadas

- **pg_partman**: menos código propio, pero extensión no garantizada en
  el pooler de Supabase y una pieza más que auditar. El job propio son
  ~40 líneas con el patrón de sweeps que ya operamos.
- **Particionar por tenant**: explota en número de particiones con el
  SaaS creciendo y no ayuda a la retención (que corta por FECHA).
- **Timescale/hypertables**: sobredimensionado para chat transaccional.

## Consecuencias

- (+) Retención gratis en I/O; índices calientes chicos; vacuum sano.
- (−) El job de particiones es una pieza más que monitorear (alerta si
  falta la partición del mes siguiente).
- (−) Ninguna FK puede apuntar a `messages` particionada sin incluir la
  columna de partición — hoy ninguna lo hace (se verificó: nada
  referencia `messages.id` por FK).

## Probar primero

En staging, con datos sintéticos al volumen real (el seed de carga de
#79 escalado ×N), ANTES de tocar producción: backfill + corte + drop de
una partición con el job de retención completo.
