# ADR 0005 · Kapso ahora, Tech Provider después

**Estado:** aceptada · 2026-09-13

## Contexto
Ser Meta Tech Provider exige app propia, verificación y operar embedded signup y
webhooks. Kapso resuelve el onboarding multi-tenant hoy, con SDK que espeja la
Cloud API de Meta.

## Decisión
Kapso como BSP detrás del puerto `WhatsAppProvider`. El vocabulario es el de la
Cloud API (`phone_number_id`, `waba_id`, ids de mensaje, plantillas, ventana de
24 h) y esos ids se guardan en nuestra base. Webhooks en modo "Meta webhooks"
(payload exacto de Meta). Kapso no guarda lógica de negocio: sus flows, agentes
y base gestionada no se usan. Conversaciones y contactos viven en nuestro
Postgres, siempre.

## Consecuencias
- Migrar es cambiar el adaptador (base URL y auth), no el módulo.
- Camino incremental documentado por Kapso (issue #82): app propia verificada
  sobre infraestructura Kapso → Multi-partner Solution → infraestructura propia.
- Riesgo conocido: números ya conectados no migran solos; requieren
  re-onboarding. Conviene verificar la app propia ante Meta temprano.

## Se revisa cuando
El margen de Kapso al volumen real lo justifique (spike #82, Fase 6).
