# ADR-0024 · Reportes legibles y carga sin trabajo duplicado

- Estado: aceptado para staging, sujeto a CI y verificación del despliegue.
- Fecha: 2026-09-21.
- Issue: #424.

## Contexto

El usuario pidió dar jerarquía a las gráficas y revisar la lentitud entre
categorías. La inspección no encontró esperas artificiales en esas rutas:
solo el debounce de 250 ms de la búsqueda, que evita una petición por tecla.
Sí había navegación con recarga completa, lecturas duplicadas de módulos y
acceso, consultas independientes en serie y cuatro viajes a Postgres para
un dashboard, incluso con pocos agregados diarios.

## Decisión

- Menú y pestañas usan `Link` de Next, y la paleta de comandos `router.push`.
  `prefetch={false}` evita precargar indiscriminadamente destinos dinámicos;
  se conserva el caché público de navegación de 60 s de #400. Menú y pestañas
  comparten los candados de una misma lectura, cancelada al cambiar el negocio.
- API keys, webhooks salientes, roles, pagos, canales, automatizaciones y
  equipo piden en paralelo sus lecturas independientes. Se conservan los
  fallbacks de consumo, widgets y roles base. No se paralelizan mutaciones.
- `getDashboard` hace una consulta parametrizada. Un CTE materializado comparte
  el agregado diario entre totales y serie. Percentiles y pendientes se leen
  en el mismo snapshot de esa sentencia. Se conservan los filtros de tenant y
  dueño, RLS, definiciones, campos, decimales y cálculo de cierre. No cambia el
  contrato ni el esquema; no hay caché de datos en el servidor. La zona del
  negocio y sus métricas comparten la misma transacción del controller,
  evitando otro BEGIN/set_config/COMMIT.
- La vista de Reportes conserva hasta tres lecturas en memoria por URL de API,
  sesión y negocio. Al volver a un rango se muestra su lectura con la hora de
  actualización y **siempre se revalida**. No se persiste en localStorage. Un
  cambio de contexto no puede mostrar datos del anterior; 401/403 vacía las
  lecturas y las respuestas canceladas no se aplican. Los errores permiten
  reintentar. El cálculo existente de los límites del rango no se modifica.
- Gráficos SVG de datos en `packages/ui`, sin nuevas dependencias ni animaciones
  que retarden los resultados. Escala desde cero, fechas, dos trazos distintos,
  leyenda, selector de día accesible y tabla. Los días sin eventos ocupan su
  fecha con cero; no se dibuja una barra mínima que sugiera actividad.
- Cierres y oportunidades se explican por separado: son métricas del rango,
  no un embudo de las conversaciones nuevas. El porcentaje visible conserva
  el redondeo publicado por la API. Se mantiene Pregúntale a tus números.

## Validación y límites

La medición en staging usa una transacción de solo lectura con snapshot fijo,
un tenant disponible y sus tres días con agregados. Compara las dos consultas
con los mismos parámetros y verifica igualdad completa de resultados. No
estima el rendimiento con millones de filas ni el tiempo completo de HTTP,
autenticación o navegador.

La medición por categoría usa build de producción, fixtures sintéticos iguales,
Chromium y una red controlada. Cuenta navegación de documento, peticiones y
milisegundos hasta completar las respuestas de datos, sin sumar la espera de
estabilización de las capturas. No son tiempos de clientes reales.

Resultados y capturas: `docs/evidencias/424/`. Se exige regresión de permisos,
RLS, rangos rápidos, cambio de negocio, errores, teclado y navegación antes de
publicar. El rollback sigue siendo el de la imagen; no hay migración que revertir.

Referencias: [Link en Next 15](https://nextjs.org/docs/15/app/api-reference/components/link)
y [alternativas para gráficos complejos del W3C](https://www.w3.org/WAI/tutorials/images/complex/).
