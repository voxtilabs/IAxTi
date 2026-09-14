# Objetivos de carga (#79, SPEC §38)

Los umbrales de escalado dejan de ser adivinanza cuando hay carga medida.
Estos son los objetivos por servicio y los gatillos numéricos; la corrida
canónica va contra **staging con datos sintéticos** (jamás prod), y la
local sirve de línea base repetible.

## Objetivos por servicio

| Servicio | Métrica | Objetivo | Gatillo etapa 2 (§38) |
| --- | --- | --- | --- |
| api (bandeja) | p95 latencia lectura | < 300 ms | p95 > 500 ms sostenido 15 min |
| api (responder) | p95 latencia escritura | < 500 ms | p95 > 800 ms sostenido |
| api (webhooks entrantes) | p95 encolar | < 200 ms | p95 > 400 ms o backlog > 1.000 |
| workers (inbound) | jobs/s por worker | ≥ 30 | backlog de cola > 5 min |
| workers (outbound) | envíos/s por número | rate limit Meta (~80 msg/s techo) | n/a (límite externo) |
| api (camino IA sin modelo) | p95 overhead | < 250 ms | n/a (el modelo domina) |

## Escenarios

1. **bandeja** — N usuarios concurrentes listando la bandeja, abriendo
   conversaciones y respondiendo (canal simulador). Mide el camino
   caliente completo lectura + escritura.
2. **webhooks** — ráfaga de entrantes firmados al webhook público del
   canal simulador. Mide verificación de firma + encolado (el criterio
   es responder < 1 s SIEMPRE: el proveedor reintenta si no).
3. **salientes** — respuestas masivas por API (la "campaña"): mide el
   camino API → DB → entrega del canal.
4. **ia** — ejecuciones del copiloto en paralelo SIN llaves de modelo:
   mide el overhead de nuestro camino (guards, cuota, DB). Con llaves,
   la latencia del proveedor domina y no es nuestra a optimizar.

## Cómo correr

```bash
# Línea base local (Postgres+Redis del docker compose):
pnpm --filter @iaxti/api exec node load-local.mjs   # levanta API + seed + 4 escenarios

# Contra staging (SOLO con datos sintéticos y en horario acordado —
# el VPS de staging es compartido):
BASE=https://api-staging.iaxti.cl TOKEN=<jwt> TENANT=<tenant-sintetico> \
  docker run --rm --network host -v $PWD/infra/load:/l grafana/k6 run /l/escenarios/bandeja.js
```

Los resultados medidos viven en `RESULTADOS.md` (se actualiza por corrida,
con fecha, ambiente y commit).
