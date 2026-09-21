# Pulso Vivo · revisión visual #404

**final result: passed** — sin hallazgos P0/P1/P2 pendientes en el alcance revisado.

## Objetivo y evidencia

Adaptación del lenguaje de VOXIA 2 al CRM conversacional IAxTi, solicitada por
el usuario. No es una reproducción exacta: se conservan la geometría oficial
de IAxTi, el acceso por código, los permisos y las acciones del producto.

- Fuente visual: `/home/bruno/VOXIA-2/app/static/`, capturada localmente sin
  consultar su API ni datos. Copia de la captura en
  `docs/evidencias/404/referencia-voxia-noche.png`.
- Implementación: build standalone de web y admin, con datos sintéticos de
  presentación. Capturas en `docs/evidencias/404/`.
- Comparación conjunta completa: `comparacion-acceso.png`; detalle a escala
  natural de material, tipografía y texto: `comparacion-detalle.png`.
- Ambos accesos: viewport CSS y captura de 1440 × 1000, escala de dispositivo
  1, modo noche, sesión cerrada, movimiento reducido. El tablero completo
  presenta ambas capturas al mismo ancho de 710 px; el detalle conserva 1:1.
- La diferencia entre contraseña de VOXIA y código/Google de IAxTi es
  intencional. No se trasladaron sus funciones ni su contenido comercial.

## Hallazgos y correcciones

1. **P1 · bordes nocturnos:** el puente shadcn declaraba `--border: var(--border)`.
   Se eliminó el ciclo y se agregó una guarda de regresión. El borde vuelve a
   usar su token semántico, sin contornos blancos accidentales.
2. **P2 · contraste:** el rojo destructivo anterior daba 4,15:1 con blanco.
   Se ajustó el token; 16 pruebas verifican texto, estados, campos y foco en
   ambas apariencias. Los placeholders usan el texto secundario legible.
3. **P2 · coherencia de superficies:** una utilidad del sidebar prevalecía sobre
   su radio nuevo. Se corrigió la especificidad; el menú plegado conserva el
   isotipo y el desplegado mantiene el nombre y el selector de negocio.
4. **P2 · controles móviles y nocturnos:** menú móvil de 46 px, nombre accesible
   en español y `color-scheme` asociado al modo para calendarios y horas nativos.
5. **P2 · densidad de bandeja:** el borde completo elevó las filas a 60,80 px,
   por encima del máximo existente de 60. Se compensó el padding del borde;
   se conserva la prueba original y el mínimo de control.

La primera revisión quedó pendiente por contraste, bordes y coherencia del
sidebar. La segunda incorporó sus correcciones y detectó la regresión de
densidad en el E2E. La tercera confirma filas de **58,80 px**, nueve visibles
en las cuatro combinaciones del test y ningún desborde; medidas en
`docs/evidencias/404/densidad.json`, captura en `bandeja-densa-movil.png` y
estado de conversación abierta en `bandeja-noche.png`. Las comparaciones
conjuntas `comparacion-acceso.png` y `comparacion-detalle.png` muestran el
acceso después de las correcciones de contraste y superficies.

## Comparación visual

| Superficie | Resultado observado |
| --- | --- |
| Tipografía | Outfit en títulos, Inter en lectura y JetBrains Mono en datos; jerarquía más marcada en acceso/inicio, lectura compacta en bandeja. Las familias coinciden con el lenguaje de referencia, con composición propia. |
| Espaciado y composición | Acceso en dos columnas, tarjeta de formulario distinguible, superficies redondeadas y navegación flotante. En móvil pasa a una columna y el menú existente sigue siendo una hoja. |
| Color y tokens | Azul de acción conservado, reflejos cian y ambiente cálido tenue. Modos día/noche completos, color semántico acompañado de texto. Efectos centralizados. |
| Marca y calidad de imagen | Isotipo oficial de IAxTi con material SVG, limpio al escalar, sin recursos externos. La geometría de VOXIA no se copió. El SVG fue pedido expresamente por el usuario. |
| Texto y contenido | Voz orientada a conversaciones, clientes y equipo; los estados, datos, enlaces y acciones proceden de las funciones existentes. Sin métricas ni controles inventados. |

La comparación conjunta se abrió y revisó completa y en detalle. Se aceptan
como decisiones propias el mayor peso de los titulares, el fondo más luminoso,
el acento cálido y la ausencia de animación ambiental continua.

## Verificación y límites

La revisión visual usa fixtures y no acredita entregas a proveedores. El E2E
de bandeja, CRM y campañas usa la API real con PostgreSQL/Redis locales. El
E2E del acceso simula exclusivamente las respuestas del proveedor OTP.

- 124 revisiones: 31 rutas en día/noche, a 1440/360 px; cero excepciones de
  página y cero desbordes. Resultado en `recorrido-visual.json`.
- 1.154 pruebas unitarias/integración; 39 del sistema UI, incluidas 16 de
  contraste. Guardas de DB (31) y core (108) repetidas sin caché.
- E2E final: **37 aprobados**, tres capturas opcionales desactivadas por
  defecto. Incluye respuesta/asignación/resolución, campañas, tablas,
  teclado, estados vacíos, onboarding, densidad y acceso por código.
- Lint, build de 30 paquetes, 54 tareas de tipos y fronteras de 610 módulos
  aprobados. No se alteraron pruebas existentes para aceptar el rediseño.

Se revisan errores JavaScript, desbordes, modo persistido, foco con teclado,
paleta de comandos, menú móvil, menú plegado, estados vacíos, formularios y
mensajes. Las instancias del SVG comparten la página sin IDs duplicados.
El transporte realtime no está implementado en el servidor de fixtures;
sus intentos de conexión no se presentan como validación del proveedor.

La verificación posterior al merge se registra en el PR con la imagen exacta
y la salud de los cinco servicios de staging. No equivale a validar todos
los proveedores externos ni todos los navegadores.
