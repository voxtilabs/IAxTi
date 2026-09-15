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
