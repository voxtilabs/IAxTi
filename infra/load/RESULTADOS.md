# Resultados medidos (#79)

## Corrida 2026-09-14 · línea base LOCAL

- **Ambiente**: servidor local (Postgres 16 + Redis 7 del docker compose,
  API compilada, un solo proceso Node). Datos sintéticos: 1 tenant,
  200 contactos, ~400 conversaciones, 5 mensajes promedio.
- **Commit**: el de este archivo. Repetible con
  `pnpm --filter @iaxti/api exec node load-local.mjs`.

| Escenario | Carga | p95 medido | Objetivo | Resultado |
| --- | --- | --- | --- | --- |
| bandeja (lectura) | 20 VUs, 70 s | **46 ms** | < 300 ms | ✓ margen 6× |
| bandeja (responder) | mezcla 25 % | **115 ms** | < 500 ms | ✓ margen 4× |
| webhooks entrantes | 50/s, 45 s | **41 ms** | < 200 ms | ✓ margen 5× |
| campaña salientes | 20/s, 30 s | **36 ms** | < 500 ms | ✓ margen 13× |
| camino IA (sin modelo) | 10 VUs | **19 ms** | < 250 ms | ✓ margen 13× |

- Fallos HTTP: 0 % en los cuatro escenarios (checks 100 %).
- Throughput sostenido observado: ~32 req/s bandeja + 50 webhooks/s en
  paralelo secuencial, sin degradación visible.

## Capacidad estimada y gatillo de etapa 2 (§38)

- Con p95 de lectura a 46 ms bajo 20 usuarios concurrentes y 50
  entrantes/s, la API está lejos de ser el cuello: la estimación
  conservadora es **30–50 tenants activos por VPS** (perfil staging:
  2 vCPU / 4 GB, 5 servicios + Redis), limitada antes por RAM del stack
  y el Postgres gestionado que por latencia de la API.
- **Gatillo numérico de la etapa 2** (ya no adivinanza): `api p95 > 500 ms
  sostenido 15 minutos` O `backlog de la cola inbound > 1.000 jobs` —
  ambos medibles hoy (OTel + BullMQ).

## Pendiente

- La corrida **canónica contra staging** (mismos scripts, `BASE=` y token
  del tenant sintético) queda para un horario acordado: el VPS de staging
  es compartido con otros proyectos y una ráfaga sin aviso no corresponde.
  Los scripts ya apuntan con solo cambiar variables.

## Trampa cazada (para el libro)

`spawnSync` del k6 bloqueaba el event loop del orquestador y su JWKS
local dejaba de responder → todo el camino autenticado "tardaba" 5 s
exactos (el timeout de jose). Con `spawn` asíncrono, los números reales.
