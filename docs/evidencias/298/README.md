# Estados vacíos y avance · #298

El componente compartido ofrece título, explicación y acción en bandeja,
contactos, oportunidades, plantillas, automatizaciones y reportes. Una búsqueda
vacía permite limpiar el filtro; no se presenta como una cartera sin contactos.

La portada conserva la puesta en marcha incorporada por #353. Se agrega avance
medido con los hechos del servidor, actualización al volver, reintento de errores
y descarte del estado al cambiar de negocio. Las rutas de cada paso continúan
siendo las declaradas por el módulo. El 403 conserva la bienvenida.

Reproducción, con PostgreSQL y Redis de desarrollo y build completo:

```sh
pnpm build
pnpm --filter @iaxti/web e2e
```

`estados-vacios.spec.ts` comprueba las seis listas, las acciones, el progreso,
finalización, reintento, permisos y cambio de negocio. Los estados de presentación
se simulan en las respuestas HTTP; `bandeja.spec.ts` mantiene el recorrido contra
la API real. El contrato SDK se contrasta con OpenAPI en `onboarding-sdk.test.ts`.

Las capturas `vacio-{dia,noche}-360.png` y `avance-{dia,noche}-360.png` se generan
con datos sintéticos, a 360 px. Se comprueban desborde y foco visible de 2 px.
