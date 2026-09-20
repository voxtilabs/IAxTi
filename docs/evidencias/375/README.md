# #375 · Hash de auditoría y jsonb

La verificación de #373 detectó una cadena inválida inmediatamente después de
crear una cita, sin manipulación. El escritor hasheaba metadata con el orden de
claves de JavaScript; jsonb podía devolver otro orden, también en objetos anidados.
Eso producía un falso diagnóstico de alteración.

La [documentación de PostgreSQL 16](https://www.postgresql.org/docs/16/datatype-json.html)
explica que jsonb no conserva el orden de claves de objetos. Se reproduce con
PostgreSQL real: cinco de los seis casos iniciales fallaban antes del cambio.

## Corrección

En la consulta que ya obtiene el hash anterior se convierte metadata a jsonb. El
hash y el INSERT usan ese mismo objeto normalizado. No se agrega un viaje a la
base, dependencia, migración ni formato de hash; el lock y el verificador permanecen.

## Pruebas

- Claves desordenadas, objetos anidados, arrays, fechas, undefined/null y número
  exponencial sobreviven al guardado y la lectura con cadena válida.
- Seis escritores concurrentes conservan la cadena.
- Fixture del formato previo: registros válidos siguen válidos; registros previos
  incompatibles siguen denunciados. Ningún hash anterior se modifica.
- Alterar metadata sigue invalidando la cadena; los tests append-only/rollback y
  exportación permanecen activos.
- Regresión de módulos consumidores de auditoría y CI del PR.

## Límite y despliegue

No repara retrospectivamente las entradas afectadas. Un tenant con un registro
previo incompatible puede seguir mostrando verificación fallida después del
despliegue; hay que diagnosticar el primer registro fallido con evidencia, sin
reescribirlo ni declararlo manipulado automáticamente. No se accedió ni modificó
contenido de auditoría de clientes para desarrollar el cambio. En una actualización
mayor de PostgreSQL se debe repetir la compatibilidad de la representación jsonb.
