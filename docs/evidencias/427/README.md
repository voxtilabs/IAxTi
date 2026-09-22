# #427 · Firma VoxTiLabs de VOXIA 2, adaptada a IAxTi

## Referencia y resultado

`referencia-voxia2.png` compara la firma anterior y los SVG originales usados en
VOXIA 2. `material-adaptado.png` compara la adaptación Pulso con esos originales:
la geometría se conserva; luces, cuerpo, profundidad y letras leen nuestros tokens.

Las tres comparaciones de navegador se abrieron y revisaron: acceso web diurno
a 1366×768, acceso admin nocturno a 360×640 y Reportes con barra lateral a 1366×768.
Escritorio se presenta a escala 0,5 y móvil a 1:1; las capturas fuente conservan
resolución completa. Diferencia intencional: el isotipo corporativo tiene volumen
y reflejos y el pie deja de atenuar la firma. La hora del reporte cambia entre
capturas porque se realizó una nueva lectura del fixture.

## Comprobaciones

- 20 vistas anteriores y 20 finales: Reportes, acceso web, invitación, acceso
  admin y administración, en día/noche y a 1366×768 / 360×640. Datos/sesiones
  sintéticos locales; no se contactan proveedores.
- Las dimensiones del documento son **idénticas en los 20 pares**. Cero overflow
  horizontal, excepciones JS, IDs SVG repetidos o referencias sin resolver.
  Los accesos siguen cabiendo completos. El admin login tiene dos instancias
  de la firma: cada una resuelve sus propios ocho IDs.
- `before.json` / `after.json` contienen las mediciones. Las firmas se revisaron
  también aisladas al tamaño real que tienen en la interfaz.
- Build 30 tareas, tipos 54, lint y dependency-cruiser aprobados. 49 tests UI y
  65 E2E aprobados sin reintentos; cinco capturas opcionales omitidas. La regresión
  incluye los dos E2E de API real incorporados por #425, Reportes, navegación, permisos y los tamaños de login de #406.
- No se añade una biblioteca ni una descarga de imagen para el lockup; el SVG
  es inline. Primera carga estimada por Next de Reportes: 490 → 491 kB (redondeo
  del reporte del build). El favicon autónomo de admin pesa 3.116 bytes.
- `/ui-check` sin hallazgos P0/P1/P2 en el alcance; `/module-check` sin fronteras
  rotas. La sustitución de IDs opera solo sobre marca versionada, nunca sobre
  entradas de usuarios. Sin nuevas APIs, permisos, datos personales ni envíos.

La verificación de la imagen exacta y salud de staging se agrega al PR tras CI
verde y merge autorizado. No se publica en producción desde esta tarea.

## Procedencia

Fuente local autorizada: proyecto VOXIA 2, `app/static/assets/`.
SHA-256 de los originales:

- `voxti-glass-tinta.svg`: `7e8372ff2867cc8bc4c81987add8734143d6322af4901663b7d7e58959246a06`
- `voxti-glass-claro.svg`: `bbd9f55706e1d4d94c0bf7abec3255da6a3bdf1beafa68cf2fcf719bdd0d864a`
- `voxti-glass.svg`: `7d53c7e0689d17f17aa04993a1f07458f83347b4fdc2062658c6d2728a171d2f`

La comparación solicitada de Reportes con #425 está en
[revision425.md](../424/revision425.md); no añade cambios funcionales en este PR.
