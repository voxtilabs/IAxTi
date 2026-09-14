# Terraform del proyecto GCP (preparado, no aplicado)

Esto **no se aplica** hasta que se cumpla la condición de la ADR-0015. Está
escrito ahora para que activarla sea revisar y correr, no empezar de cero.

`main.tf` declara lo mínimo para levantar IAxTi en GKE Autopilot con datos
gestionados. No incluye el chart: eso es `infra/helm/iaxti`, que se instala
después con el `kubeconfig` que deja este Terraform.

## Antes de correrlo

1. Un proyecto GCP con facturación activa y la región decidida (por defecto
   `southamerica-west1`, Santiago: la latencia y la residencia son el motivo
   por el que alguien pediría esto).
2. Backend de estado remoto en un bucket GCS — el estado local se pierde con
   el equipo y con él la capacidad de destruir lo creado.
3. `terraform plan` revisado por una persona. Nunca `apply` directo.

## Lo que NO está acá, a propósito

- **Secretos.** Van a Secret Manager y se montan como Secret de Kubernetes
  fuera de este estado: un secreto en el estado de Terraform es un secreto
  en un bucket.
- **Postgres.** Si el cliente exige residencia, entra Cloud SQL; si no, sigue
  Supabase. Es la decisión que se toma con el cliente en la mesa, no antes.
