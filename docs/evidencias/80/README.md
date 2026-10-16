# #80 · Checklist mensual de staging desde producción anonimizada

Este cambio entrega el checklist y un derivado estructural local como avance
técnico parcial del criterio 3 de
[#80](https://github.com/voxtilabs/IAxTi/issues/80):
[checklist de DR](../../runbooks/DR.md#staging-anonimizado-mensual).
**No se ejecutó una restauración, no se accedió a producción y no se acredita
RPO/RTO.** El criterio completo y la issue permanecen pendientes.

## Fuentes y alcance

- Issue y su único comentario releídos el 2026-10-16. El comentario del
  2026-09-15 registra rollback de 192 s / 24 s; esos resultados históricos
  permanecen en [RESULTADOS-DR.md](../../runbooks/RESULTADOS-DR.md).
- [SPEC](../../SPEC.md), §27 y §36–37: RPO/RTO, restore mensual de staging
  desde backup de producción, datos anonimizados y smoke del producto. La
  referencia antigua a §15 en la issue corresponde ahora a §27 del SPEC.
- [Inventario de datos](../../INVENTARIO-DATOS.md),
  [reglas de seguridad](../../../.claude/rules/seguridad.md) y
  [rol de aplicación](../../runbooks/ROL-DE-LA-APLICACION.md): superficies
  sensibles, separación de ambientes y verificación de RLS.
- Base revisada: `79936e77bfa57ebcfbcc16b81888af2fdb9983c7`.

El runbook ahora separa preparación, restauración en cuarentena,
anonimización, importación a staging, smoke, medición y limpieza. Incluye
identidades/Auth, contenido libre, adjuntos, credenciales, colas y auditoría;
la cobertura real depende del esquema del backup, no de una lista congelada.

En el corte documental inicial había dos pendientes: implementar/verificar un transformador integral
de la copia y ejecutar el ensayo autorizado con acceso al backup y staging.
El repositorio de la base `79936e7` no incluía el script mensual previsto por SPEC;
la redacción de PII en observabilidad y la supresión de un contacto no lo
sustituyen. La documentación no inventa un comando ni da ese código por hecho.
Los ensayos PITR, Redis/R2 y VPS limpio conservan su alcance independiente.

## Verificación de la entrega documental inicial

- `git diff --check`: sin errores de whitespace.
- Enlaces Markdown locales nuevos y sus anclas: destinos existentes.
- Revisión documental contra issue, comentario y SPEC: frecuencia mensual,
  aislamiento, transformador verificable, smoke, tiempos reales, comparación
  RPO/RTO, desvíos y próxima fecha.
- Revisión de seguridad: el artefacto sin anonimizar queda en cuarentena;
  consumidores detenidos; no revocar secretos de producción ni reejecutar
  pendientes copiados; evidencias sin datos personales.
- Sin cambios de código, SQL, endpoints, permisos, manifiestos, imágenes ni
  configuración desplegada. No se corrieron pruebas de aplicación ni
  preflight: no aportarían evidencia de una restauración que no se ejecutó.

## Continuación técnica: derivado estructural local

Se añade [scripts/dr](../../../scripts/dr/README.md), con cobertura explícita
por tabla/columna, exportación de solo lectura e importación atómica a una base
local nueva que queda sin admitir conexiones. La [evidencia de las pruebas](transformer.md)
separa la ejecución SQL local sobre 113 migraciones de los cuatro tests puros
que también puede ejecutar CI sobre esta rama de 97 migraciones.

El derivado conserva solo 12 tablas y no restaura las 84 excluidas. Omite
Auth, Storage, auditoría y trabajo pendiente; las cantidades y relaciones
pueden conservar patrones identificables. No acredita anonimización integral,
RPO/RTO ni el restore mensual de C3. Requiere revisión en cuarentena, nuevas
identidades sintéticas/revinculación, archivos sintéticos y smoke posterior.

<a id="registro-mensual"></a>

## Plantilla del registro mensual

Copiar esta plantilla junto con las casillas de §6 del runbook en
`RESULTADOS-DR.md` **al realizar el ensayo**. Reemplazar cada `pendiente` por
evidencia o por el motivo de no ejecución. No marcar un paso solo por estar
documentado. Nunca pegar credenciales, muestras originales ni URLs firmadas.

| Campo | Registro del ensayo, todavía sin ejecutar |
|---|---|
| Mes, operador y revisor | pendiente |
| Ventana y coordinación de staging | pendiente |
| Origen, cuarentena y staging (identificadores sin secretos) | pendiente |
| Backup: formato, tamaño, checksum, esquema e instante recuperable | pendiente |
| Punto de recuperación objetivo, fijado antes de empezar | pendiente |
| Imagen: SHA completo; transformador: SHA y verificaciones | pendiente |
| Cobertura de tablas/columnas y exclusiones del derivado | pendiente |
| Herramienta/comando de restore, con credenciales redactadas | pendiente |
| Derivado: checksum, conteos y revisión de anonimización | pendiente |
| `t_inicio` / `t_restore` / `t_anonimizado` / `t_importado` / `t_verificado` | pendiente |
| Duración total y por etapa, incluidos intentos fallidos | pendiente |
| Último hito confirmado recuperado y evidencia previa a anonimizar | pendiente |
| Pérdida observada frente al objetivo; comparación RPO 5 min | no demostrado |
| Tiempo hasta producto verificado; comparación RTO 1 h | no demostrado |
| RLS, permisos, Auth de staging y smoke de mensaje/respuesta | pendiente |
| Comprobación de ausencia de efectos externos/replays | pendiente |
| Resultado, fallos y referencias a su seguimiento | no ejecutado |
| Retorno al estado previo de staging si falló | pendiente |
| Limpieza comprobada de copias temporales y referencias a evidencia sin PII | pendiente |
| Próxima fecha mensual y responsable | pendiente |
