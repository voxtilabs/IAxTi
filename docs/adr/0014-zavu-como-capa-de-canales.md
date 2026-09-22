# ADR 0014 · Zavu como capa de canales; proveedor propio mucho después

**Estado:** aceptada · 2026-09-14 · supersede la [ADR-0005](0005-kapso-ahora-tech-provider-despues.md)

## Contexto
La ADR-0005 eligió Kapso como BSP de WhatsApp y dejó el vocabulario de la Cloud
API de Meta en nuestra base para poder migrar a Tech Provider propio cambiando
el adaptador. Esa apuesta optimizaba una independencia que está a años, no a
meses: antes hay que probar el producto con los primeros clientes.

Dos cosas cambiaron la evaluación:

1. **El diferenciador comercial es omnicanal.** La competencia hace WhatsApp.
   Instagram y Messenger son el argumento de venta, y Kapso no los tiene.
2. **Instagram y Messenger por Meta directo exigen App Review y verificación de
   negocio**: semanas de calendario que no controlamos, con el producto todavía
   sin validar.

Zavu entrega WhatsApp, Instagram y Messenger con **un solo envelope y un solo
esquema de firma**, y el onboarding del cliente por *partner invitation* no nos
obliga a pasar por la revisión de Meta. Tres canales son un adaptador, no tres.

## Decisión
Zavu como capa de canales detrás del puerto `ChannelProvider`, **solo como
transporte**. Sus Agents, Functions, Flows, Memory y Broadcasts no se usan: la
conversación, los contactos, la IA y la automatización viven en nuestro Postgres
y en nuestros módulos, como siempre (SPEC §12).

El vocabulario de Zavu **no cruza el puerto**. Sus identificadores viven en
columnas del adaptador (`senderId`, su `messageId`); el dominio no los conoce.
Cuando llegue el WAMID de Meta lo guardamos igual, porque es gratis y sirve el
día de la migración.

La independencia —app propia de Meta, Tech Provider para WhatsApp y Graph
directo para Instagram y Messenger— es la **Fase 7** del roadmap, con su propio
gatillo numérico (#82) y su plan de salida ensayado (#159).

## Consecuencias
- Migrar de proveedor sigue siendo cambiar el adaptador: es lo que esta decisión
  compra, y es la razón de que se pueda tomar sin drama.
  **Medido el 22/09/2026 (#159)**: era cierto para el camino de ENTRADA y falso
  para las plantillas, que se llamaban por su nombre desde la API y el barrido.
  Ya pasan por el puerto. Sigue siendo falso para el ENVÍO —`outbound.ts` llama
  al módulo whatsapp directamente, porque ahí viven el reintento, la pausa por
  calidad y la ventana de 24 h— y eso es a sabiendas: está escrito en
  `docs/runbooks/SALIR-DEL-INTERMEDIARIO.md` con lo que costaría.
- **El costo de volver crece con cada número conectado**, porque el
  re-onboarding es cliente por cliente. Por eso se mueve ahora, con cero
  clientes conectados, y no en seis meses.
- Perdemos, por ahora, el vocabulario de Meta como lengua franca: los ids de
  Zavu no son los de Meta y el día del cambio hay que re-conectar.
- Riesgos asumidos a sabiendas, sin respuesta del proveedor al momento de
  decidir: el precio mensual por conexión y si un solo proyecto sostiene
  limpiamente los WABA de decenas de clientes. Zavu no separa facturación por
  cliente final: todo cae a nuestra cuenta y se prorratea en `usage_meters`.
- Las pegas conocidas de Zavu que **no** nos afectan, porque solo lo usamos de
  transporte: sus agentes sin tools en canales de texto, su búsqueda que no mira
  dentro de los mensajes, sus broadcasts con revisión humana, sus tags sin API y
  su "la API no guarda estado de workspace".

## Se revisa cuando
El gatillo numérico del #82 se cumpla, o cuando una capacidad que necesitemos
—Flows de Meta (#85), Calling API (#86)— no exista detrás del intermediario.
