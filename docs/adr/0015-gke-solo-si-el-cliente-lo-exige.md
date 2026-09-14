# ADR 0015 · GKE solo si un cliente lo exige

**Estado:** aceptada · 2026-09-14

## Contexto
La etapa 4 del camino de escalado (SPEC §15) es Kubernetes. Es también la
etapa que más fácil se adelanta por gusto: un clúster se ve más serio que un
VPS con Docker Compose, y esa es exactamente la razón equivocada para tenerlo.

Hoy IAxTi corre en un VPS con Dokploy y aguanta de sobra el volumen real.
Kubernetes agrega operación —parches, upgrades de plano de control, políticas
de red, costo base del clúster— que alguien tiene que pagar y atender, y ese
alguien es una persona sola.

## Decisión
**Kubernetes no se despliega hasta que un cliente lo exija**, y "lo exija"
significa una de estas tres, por escrito en su contrato:

1. **Aislamiento de red**: el cliente requiere que su tráfico y sus datos no
   compartan infraestructura con otros tenants.
2. **SLA contractual** con penalidad que el VPS no puede sostener (multi-zona,
   failover automático, RTO comprometido).
3. **Residencia de datos** en una región donde el proveedor actual no está.

Sin una de las tres, la respuesta es no — por buena que suene la conversación.

**Y mientras tanto el chart se mantiene vivo**: `infra/helm/iaxti` se valida
en cada PR que lo toca y en cada release, con `helm lint`, render y un
`--dry-run=server` contra un kind de verdad. Un chart que nadie ejecuta se
pudre en silencio, y el día que la condición aparezca no hay tiempo para
descubrir que no arranca.

## Consecuencias
- Activar GKE es revisar el Terraform, correr el chart y migrar datos: horas,
  no un proyecto. Esa es toda la razón de mantenerlo.
- Se paga un costo pequeño y permanente: el CI del chart y el Terraform que
  hay que mantener al día aunque no se aplique.
- **La misma imagen corre en los dos lados.** El día que se divergen —un
  Dockerfile para Compose y otro para Kubernetes— este ADR deja de ser cierto
  y hay que reescribirlo.
- Las dependencias con estado (Postgres, Redis) **no entran al chart**: van a
  servicios gestionados. Un Postgres dentro del clúster es la forma más rápida
  de convertir una caída de nodo en una pérdida de datos.
- Los secretos **no los crea el chart**: llegan como un Secret que ya existe.
  Un chart que crea secretos termina con los secretos en git.

## Se revisa cuando
Aparezca un cliente que cumpla la condición, o cuando el VPS deje de aguantar
el volumen real —lo que diga el load testing (#79), no la intuición.
