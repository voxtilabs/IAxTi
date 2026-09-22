# #424 · Reportes y carga por categoría

## Qué causaba la demora

No se encontraron esperas artificiales para mostrar datos. La búsqueda de la
paleta conserva su debounce de 250 ms. Las transiciones CSS no bloquean las
consultas. Los problemas observados eran trabajo duplicado y viajes en serie:

- Links nativos recargaban el documento al cambiar de categoría o pestaña.
- Shell y pestañas repetían módulos y acceso incluso fuera de ajustes.
- Siete pantallas esperaban lecturas independientes una detrás de otra.
- El dashboard hacía cuatro consultas SQL y otra transacción para la zona.

Se eliminan esos viajes; no se añade ninguna espera. Los snapshots de rangos
viven solo en memoria de la vista y siempre se revalidan con indicador visible.

## Consulta real en staging

`consulta-staging.jsonl`: 15 comparaciones de `getDashboard`, cinco por rango
7/30/90, el único tenant disponible con tres días de agregados. Misma conexión,
parámetros y snapshot `REPEATABLE READ READ ONLY`; igualdad completa comprobada
en las 15 comparaciones. La consulta nueva se ejecutó como diagnóstico acotado,
sin instalar código ni modificar datos en el servidor.

Mediana global: **259 → 66 ms (−74,5 %)**. Mide solo el servicio de consulta,
no HTTP, autenticación, transacciones del controller ni navegador. La dispersión
anterior aparece en las muestras; no es una prueba de carga con gran volumen.
La eliminación de la segunda transacción del controller es adicional y no se
incluye en ese porcentaje.

## Navegador por categoría

Build de producción anterior `0568202` y posterior basado en `facfd8b`, fixtures
sintéticos iguales, Chromium, 1440×1000 y movimiento reducido. Red CDP: 100 ms
de latencia, 10 Mbps de descarga y 5 Mbps de subida. Cinco navegaciones por
categoría; se entra desde Inicio o una pestaña hermana usando el enlace real.

La métrica es desde el clic hasta completar la última respuesta de datos de la
vista. Se espera título correcto, red quieta y dos frames antes de registrar;
la espera de estabilización no se suma al tiempo. No equivale al LCP ni a una
medición de usuarios reales. El backend de fixtures no reproduce la latencia
real de Postgres; separa el efecto de navegación y peticiones en serie.

| Categoría | Antes, mediana ms | Después, mediana ms | Reducción | P95 antes → después ms |
|---|---:|---:|---:|---:|
| IA (`/ajustes/ia`) | 535 | 432 | 19.3 % | 623 → 599 |
| Reportes (`/reportes`) | 548 | 423 | 22.8 % | 628 → 531 |
| Auditoría (`/ajustes/auditoria`) | 463 | 289 | 37.6 % | 556 → 405 |
| API (`/ajustes/api`) | 649 | 401 | 38.2 % | 813 → 513 |
| Roles (`/ajustes/roles`) | 529 | 397 | 25.0 % | 585 → 484 |
| Automatizaciones (`/ajustes/automatizaciones`) | 513 | 388 | 24.4 % | 536 → 404 |
| Campañas (`/campanas`) | 538 | 405 | 24.7 % | 625 → 512 |
| Facturación (`/ajustes/facturacion`) | 426 | 295 | 30.8 % | 459 → 324 |
| Agenda (`/agenda`) | 455 | 294 | 35.4 % | 524 → 418 |
| Canales (`/ajustes/canales`) | 555 | 385 | 30.6 % | 647 → 502 |
| Bandeja (`/bandeja`) | 440 | 383 | 13.0 % | 558 → 519 |
| Contactos (`/contactos`) | 534 | 412 | 22.8 % | 576 → 507 |
| Campos (`/ajustes/campos`) | 432 | 327 | 24.3 % | 468 → 339 |
| Empresas (`/empresas`) | 435 | 317 | 27.1 % | 533 → 399 |
| Etiquetas (`/ajustes/etiquetas`) | 446 | 323 | 27.6 % | 513 → 426 |
| Oportunidades (`/oportunidades`) | 441 | 396 | 10.2 % | 517 → 489 |
| Equipo (`/ajustes/equipo`) | 461 | 393 | 14.8 % | 554 → 483 |
| Webhooks (`/ajustes/webhooks`) | 643 | 400 | 37.8 % | 675 → 518 |
| Conocimiento (`/ajustes/conocimiento`) | 434 | 300 | 30.9 % | 536 → 390 |
| Avisos (`/ajustes/notificaciones`) | 523 | 418 | 20.1 % | 588 → 436 |
| Ajustes (`/ajustes/bandeja`) | 442 | 308 | 30.3 % | 546 → 424 |
| Pagos (`/ajustes/pagos`) | 551 | 372 | 32.5 % | 566 → 494 |
| Plantillas (`/ajustes/plantillas`) | 408 | 301 | 26.2 % | 568 → 419 |

230 navegaciones verificadas: 115 anteriores con una recarga de documento y
115 posteriores sin recarga; dos peticiones menos por transición. Sin errores
JS, HTTP fallidos ni skeleton pendiente al terminar. El P95 por rango cercano
con cinco muestras es el máximo observado: no representa un percentil estable.
IA se repitió en ambas versiones desde Reportes tras completar su fixture.
Los otros 22 destinos usan el mismo origen descrito arriba.

Datos completos en `before-performance.json` y `after-performance.json`.


## Revisión de interfaz

`before-*` y `after-*`: mismo período y datos en día/noche, 1440×1000 y 360×800.
Las cuatro comparaciones conjuntas fueron abiertas para revisar tipografía,
espaciado, color, gráficas y estados. Los JSON de captura cubren también 7 y
90 días: 12 vistas por versión, sin errores JS ni overflow horizontal.
Se corrigió el quiebre de montos móviles detectado en la primera iteración.

## Validación técnica

- Build: 30 tareas aprobadas; tipos: 54; lint y dependency-cruiser aprobados.
- 49 tests UI, 58 web, 19 analytics y 2 HTTP de analytics aprobados.
- 63 E2E aprobados sin reintentos; cinco capturas opcionales omitidas.
- Tests nuevos: escala desde cero, calendario diario, equivalencia de métricas,
  consulta única, dueño, RLS con rol sin BYPASSRLS, respuestas desordenadas,
  cambio de negocio, 403, 503/reintento, teclado y navegación sin recarga.
- `/module-check`: fronteras conservadas, sin manifiestos ni endpoints nuevos.
- `/security-review`: sin hallazgos en el alcance. Se conservan guardas,
  contexto y consultas parametrizadas. La memoria no cruza sesiones/tenants,
  no es persistente y se limpia al denegar acceso. Sin nuevos flujos de PII,
  proveedores, herramientas de IA, dependencias o secretos. No requiere una
  fila nueva en COMPLIANCE_BASELINE.
- `/ui-check`: tokens compartidos, día/noche, 360 px, foco y estados revisados.
- Bundle de la ruta: 3,54 → 5,29 kB; primera carga 483 → 490 kB. Se acepta ese
  coste de presentación sin introducir una biblioteca de gráficos.

El CI completo y la verificación de staging se documentan en el PR. Las pruebas
locales usan Postgres/Redis; OTP y proveedores no se ejercitan como servicios reales.
Rollback mediante imagen anterior; no hay migraciones.
