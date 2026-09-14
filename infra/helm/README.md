# Runbook · levantar IAxTi en GKE

**Esto no se corre por gusto.** La condición de activación está en la
[ADR-0015](../../docs/adr/0015-gke-solo-si-el-cliente-lo-exige.md): sin un
cliente que la cumpla por escrito, IAxTi sigue en el VPS con Dokploy.

El chart usa **la misma imagen** que Compose (`ghcr.io/voxtilabs/iaxti`), con
los mismos cinco entrypoints. Lo único que cambia es quién la orquesta.

## Antes de empezar

- El tag exacto que se va a desplegar. `latest` está prohibido: un pod que se
  reprograma no puede terminar con una versión distinta a la de sus hermanos.
- `DATABASE_URL` y `REDIS_URL` del ambiente nuevo, ya creados (Cloud SQL o
  Supabase; Memorystore para Redis). **El chart no crea dependencias con
  estado**: un Postgres dentro del clúster convierte una caída de nodo en una
  pérdida de datos.
- Decidido si migran datos del VPS o el cliente parte limpio.

## 1. Infraestructura

```bash
cd infra/terraform
terraform init
terraform plan -var project_id=EL-PROYECTO   # se REVISA, no se aplica a ciegas
terraform apply -var project_id=EL-PROYECTO
gcloud container clusters get-credentials iaxti --region southamerica-west1 --project EL-PROYECTO
```

## 2. Secretos

Van a un Secret que el chart solo **lee**. Nunca a `values.yaml`, que vive en
git.

```bash
kubectl create namespace iaxti
kubectl -n iaxti create secret generic iaxti-env \
  --from-literal=DATABASE_URL='...' \
  --from-literal=REDIS_URL='...' \
  --from-literal=SUPABASE_URL='...' \
  --from-literal=SUPABASE_ANON_KEY='...' \
  --from-literal=SUPABASE_JWKS_URL='...' \
  --from-literal=ZAVU_API_KEY='...' \
  --from-literal=ZAVU_WEBHOOK_SECRET='...'
```

## 3. Ensayo antes del despliegue

```bash
helm template iaxti infra/helm/iaxti --namespace iaxti --set image.tag=vX.Y.Z | less
helm install iaxti infra/helm/iaxti --namespace iaxti --set image.tag=vX.Y.Z --dry-run=server
```

Si el render no se lee entero antes del primer despliegue, el primer
despliegue es el que lo lee.

## 4. Despliegue

```bash
helm upgrade --install iaxti infra/helm/iaxti \
  --namespace iaxti \
  --set image.tag=vX.Y.Z \
  --set ingress.habilitado=true \
  --set ingress.host=app.cliente.cl \
  --wait --timeout 10m
```

Las migraciones corren **antes** que el código nuevo, como hook `pre-upgrade`,
con `backoffLimit: 0`. Una migración que falla se mira; no se reintenta a
ciegas. Si el Job falla, el upgrade se detiene y la versión vieja sigue
sirviendo — que es exactamente lo que se quiere.

## 5. Verificar

```bash
kubectl -n iaxti get pods
kubectl -n iaxti logs -l app.kubernetes.io/component=api --tail=50
kubectl -n iaxti port-forward svc/iaxti-api 3000:3000 &
curl -fsS localhost:3000/health && curl -fsS localhost:3000/ready
```

Y la prueba que de verdad importa: **un mensaje entrante llega a la bandeja**.
Los `/health` dicen que el proceso está vivo, no que el producto funciona.

## Volver atrás

```bash
helm rollback iaxti --namespace iaxti --wait
```

`helm rollback` devuelve el código, **no la base**. Si la migración no era
compatible hacia atrás, el rollback deja código viejo contra esquema nuevo. Por
eso las migraciones son aditivas (SPEC §27): esa regla es lo que hace que este
comando sirva.

## Lo que este runbook NO cubre

- Migrar los datos del VPS al ambiente nuevo: se planifica con el cliente,
  con ventana y ensayo previo.
- Reapuntar el webhook del proveedor de canales al dominio nuevo. Mientras no
  se haga, los mensajes siguen llegando al ambiente viejo y **nadie se da
  cuenta hasta que alguien reclama**.
