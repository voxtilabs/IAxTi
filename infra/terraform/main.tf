# IAxTi en GCP — preparado, sin aplicar (#83, ADR-0015).
# La condición de activación está en la ADR: sin cliente que la cumpla, esto
# no se corre.

terraform {
  required_version = ">= 1.9"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
  # El estado va a un bucket antes del primer apply. Con estado local, el
  # día que el equipo se pierda no hay forma de destruir lo creado.
  # backend "gcs" { bucket = "iaxti-tfstate" prefix = "prod" }
}

variable "project_id" {
  description = "Proyecto GCP donde vive este ambiente"
  type        = string
}

variable "region" {
  description = "Región. Santiago por latencia y por residencia de datos."
  type        = string
  default     = "southamerica-west1"
}

variable "cluster_name" {
  type    = string
  default = "iaxti"
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# Autopilot: sin nodos que parchar a mano. El motivo para estar acá es un
# requisito del cliente, no las ganas de operar Kubernetes.
resource "google_container_cluster" "iaxti" {
  name             = var.cluster_name
  location         = var.region
  enable_autopilot = true

  # Sin IP pública en el plano de control: si estamos acá es por aislamiento.
  private_cluster_config {
    enable_private_nodes    = true
    enable_private_endpoint = false
  }

  release_channel {
    channel = "REGULAR"
  }

  # Borrar un clúster con datos de clientes no puede ser un `terraform apply`
  # distraído.
  deletion_protection = true
}

# Redis gestionado: las dependencias con estado NO viven en el chart.
resource "google_redis_instance" "cola" {
  name           = "${var.cluster_name}-redis"
  tier           = "STANDARD_HA"
  memory_size_gb = 1
  region         = var.region

  # Las colas de BullMQ no toleran perder datos en un failover silencioso.
  persistence_config {
    persistence_mode    = "RDB"
    rdb_snapshot_period = "ONE_HOUR"
  }
}

# Identidad del despliegue: solo lo necesario para leer secretos y bajar la
# imagen. Nada de roles amplios "para que funcione".
resource "google_service_account" "iaxti" {
  account_id   = "${var.cluster_name}-app"
  display_name = "IAxTi (aplicación)"
}

resource "google_project_iam_member" "secretos" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.iaxti.email}"
}

output "kubeconfig_comando" {
  description = "Cómo apuntar kubectl a este clúster"
  value       = "gcloud container clusters get-credentials ${google_container_cluster.iaxti.name} --region ${var.region} --project ${var.project_id}"
}

output "redis_host" {
  value     = google_redis_instance.cola.host
  sensitive = true
}
