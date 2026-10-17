# Tres hallazgos concretos de Semgrep (#758)

La imagen ejecuta sus cinco servicios como UID/GID1000. El código y el entrypoint siguen propiedad de root; solo las cachés de Next de web/admin son escribibles por el proceso. Helm ya utiliza ese UID. Se conservan la imagen base y los puertos existentes.

Los dos usos señalados en el frontend llevan el motivo junto a la supresión de su regla: el sondeo HTTP apunta a loopback en un arnés sintético sin credenciales, y el HTML del login proviene de SVG constantes versionados. Se revisaron los dos consumidores de LoginCard y la transformación limitada a identificadores de useMarcaSvg.

## Verificación del 16 de octubre

- `TODO=1 pnpm antes-de-empujar`: verde; 2.885 pruebas aprobadas y14 omitidas existentes en28 paquetes; 54 tareas de tipos,30 de build y97 migraciones sobre base nueva. Generadores, lint y trinquetes sin regresiones.
- Semgrep1.180.0, packs `p/typescript`, `p/owasp-top-ten` y `p/secrets`, mismos tres archivos antes/después: tres hallazgos antes, cero después, cero errores;117 reglas aplicables. La repetición usa `--jobs 1` tras un primer intento que agotó recursos de io_uring.
- Escaneo completo adicional:17 hallazgos (14 tags de Actions y3 políticas pnpm), con9 advertencias de análisis sintáctico. No se presenta como cobertura completa ni como árbol limpio; los packs del registro son variables y este conteo no sustituye la lista histórica de la issue.
- Build local de imagen y cinco contenedores efímeros: API, web, admin, workers y agents responden200 en `/health`; todos ejecutan UID1000. Se comprobó que el proceso no puede escribir código y sí puede escribir las cachés Next. API/workers/agents también responden200 en `/ready`; web/admin responden503 porque este smoke no configura sus dependencias de autenticación/API. No acredita disponibilidad externa.
- El espejo privado GHCR no pudo descargarse. Solo el contexto temporal del build sustituyó las dos líneas FROM por `docker.io/library/node:22-alpine`; el Dockerfile del repositorio conserva el espejo original. Imagen local de prueba: `986a04487c9ba714b010456c7b7594888b6713d821ecdfbf2aa4e8a235338ae2`.
- Revisión de un agente distinto del autor, con contexto compartido: sin objeciones en estos cambios. No se publicaron imágenes ni se modificó un despliegue.

## Alcance pendiente

Refs #758; no cierra la issue. La política de tags de Actions y las tres decisiones de pnpm siguen pendientes de la decisión solicitada en el texto original. Se conserva `--baseline-commit` mientras haya hallazgos pendientes. El grupo de inyección de shell/workflow checkout ya fue atendido por #763 según los comentarios de la issue.

Referencias: [usuario no privilegiado en Node](https://github.com/nodejs/docker-node/blob/main/docs/BestPractices.md), [supresiones específicas de Semgrep](https://docs.semgrep.dev/ignoring-files-folders-code).
