# Escala y densidad · #297

Capturas de la aplicación local compilada, con veinte contactos sintéticos
idénticos para comparar. Playwright comprueba día/noche, 360/1280 px, ausencia
de scroll horizontal, tamaño del título y foco visible. El flujo de bandeja
contra la API real pasa en la misma corrida.

La fila de bandeja pasó de **70,5 px a 59,80 px** (15,2 % menos altura),
con controles de al menos 46 px. En el mismo panel caben diez filas completas,
antes nueve. En pantalla a 1280×900 quedan ocho filas completas visibles; el
encabezado existente ocupa parte de la altura y se sigue por separado en #295.

| | Antes | Después |
|---|---|---|
| Día, escritorio | [captura](antes/dia-1280.png) | [captura](despues/dia-1280.png) |
| Noche, escritorio | [captura](antes/noche-1280.png) | [captura](despues/noche-1280.png) |
| Día, 360 px | [captura](antes/dia-360.png) | [captura](despues/dia-360.png) |
| Noche, 360 px | [captura](antes/noche-360.png) | [captura](despues/noche-360.png) |

Las mediciones JSON distinguen `filasEnPanel` de `visiblesEnPantalla`: el
contenedor de la bandeja puede extenderse debajo del viewport; no se cuentan
esas filas como visibles en pantalla. La captura inicial solo midió el panel.

Reproducir: `pnpm build` y `node apps/web/e2e/run-e2e.mjs`, con PostgreSQL y
Redis locales. Para capturar la versión previa se usó `IAXTI_CAPTURA_ANTES=1`
contra el build anterior al cambio. No son imágenes de clientes reales.
