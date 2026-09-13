# ADR 0002 · Supabase como datos e identidad

**Estado:** aceptada · 2026-09-13

## Contexto
Necesitamos Postgres con RLS, autenticación con Google y MFA, realtime para la
bandeja y backups con PITR — sin operar nada de eso.

## Decisión
Supabase Cloud: Postgres + pgvector con RLS, Auth, Realtime, PITR. Un proyecto
por ambiente (staging, prod), región São Paulo, **la misma región que el VPS**
(SPEC §40). La API es la única puerta: el frontend nunca consulta tablas.
Realtime de la bandeja por broadcast desde la API, nunca `postgres_changes`.

## Consecuencias
- RLS como segunda cerradura del multi-tenancy (`SET app.tenant_id`).
- Supabase Free no se usa ni para staging (se pausa a los 7 días).
- El componente más crítico (datos) es el que menos administramos.

## Se revisa cuando
- Un cliente exige residencia de datos → Cloud SQL o dedicado (nuevo ADR).
- El costo obliga → Postgres en el VPS vía Dokploy con backups a R2 cada 6 h,
  sin PITR, con fecha de revisión escrita (SPEC §36).
