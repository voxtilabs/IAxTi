# Bandeja contenida en la ventana · revisión #429

**final result: passed** en el alcance reproducido de desplazamiento y
adaptación móvil/tablet. Evidencia: [capturas y medidas](docs/evidencias/429/README.md).

Se abrieron primero las capturas de staging `8cbf762`, con datos sintéticos
de tres y cincuenta conversaciones, y luego las comparaciones conjuntas
con el build corregido: escritorio nocturno 1366×768, chat móvil diurno
360×640 y tablet diurna 768×768. Se preservan tokens, marcas y funciones.

Hallazgos resueltos:

- **P1 · documento vacío al bajar.** Las etiquetas accesibles del canal
  escapaban de la lista: documento de 3.288 px en una ventana de 768 px.
  Contenedor relativo en `CanalChip` y paneles con scroll propio. La
  altura definitiva del documento coincide con la ventana.
- **P2 · soporte empuja la bandeja.** El shell reparte la altura disponible
  entre aviso, cabecera y contenido; autoscroll limitado al historial.
- **P2 · contacto y botones se solapan en móvil.** El encabezado admite
  filas distintas; nombre, teléfono y acciones permanecen legibles.
- **P2 · tablet fuerza tres paneles.** A 768 px el documento medía 832 px
  y el chat quedaba recortado. La navegación existente por panel se usa
  bajo 1024 px; desde ese ancho se mantienen las tres columnas.

Se comprobaron día/noche, 360/768/1024/1366 px, cambios de altura, historiales
largos y foco. E2E: 68 aprobados (cinco capturas opcionales omitidas), con
regresión nueva en tres tamaños; antes del arreglo fallaba en móvil y
escritorio. Reportes conserva su scroll y los overlays siguen funcionando.
No se inspeccionaron mensajes de clientes. Las capturas usan la interfaz
real y respuestas sintéticas; E2E valida además sesión y API locales reales.

---

# Firma VoxTiLabs con volumen · revisión #427

**final result: passed** — sin hallazgos visuales P0/P1/P2 pendientes en el alcance.

Se aplica la firma vectorial de VOXIA 2 autorizada por el usuario, con la
geometría oficial existente y material de `--jelly-*`. Las letras conservan
los tonos de texto de IAxTi. Se mantiene la composición y el tamaño del acceso.
Fuente anterior: build `fa15277`; referencia externa: SVG locales de VOXIA 2.

La referencia, el material adaptado y las comparaciones conjuntas de acceso
web diurno, admin móvil nocturno y Reportes diurno fueron abiertas y revisadas.
Están en `docs/evidencias/427/`. Viewports CSS iguales en cada par, densidad 1,
escritorio 1366×768 y móvil 360×640; comparaciones a escala 0,5 y 1 respectivamente.
Las capturas individuales conservan resolución nativa.

Hallazgos corregidos:

- **P2 · firma plana y atenuada.** Se incorpora el acabado de volumen y luces
  y se elimina la opacidad del 70 % en el pie. La identidad tipográfica no cambia.
- **P2 · referencias compartidas al repetir el SVG.** Cada instancia asigna
  IDs SSR propios. El acceso admin verifica dos firmas sin IDs repetidos ni
  referencias a otro SVG.

20 pares de vistas con dimensiones del documento idénticas, sin excepciones JS
ni overflow horizontal. Los logins siguen entrando completos. El material es
estático; colores, espaciado y tipografía de los controles se conservan. El
favicon corporativo de admin también usa el isotipo de VOXIA 2.

Validación: build 30 tareas, tipos 54, lint, fronteras, 49 tests UI y 65 E2E
aprobados; cinco capturas opcionales omitidas. Sesiones/datos visuales sintéticos,
OTP simulado. Verificación del despliegue registrada posteriormente en el PR.

---

# Reportes con jerarquía y navegación fluida · revisión #424

**final result: passed** — no quedan hallazgos visuales P0/P1/P2 en el
alcance revisado. Las métricas, permisos y funciones existentes se conservan.

## Fuente y evidencia

Solicitud: rediseñar gráficas simplistas y diagnosticar la carga por categoría.
Fuente: build de staging `0568202`, antes del cambio. Implementación basada en
`facfd8b`, que incorpora también el avance independiente de staging.

Capturas de navegador con los mismos fixtures sintéticos, período de 30 días,
fecha de referencia 2026-09-21, modo, viewport CSS y densidad 1. Escritorio
1440×1000 y móvil 360×800. Las comparaciones conjuntas de `docs/evidencias/424/`
se abrieron y revisaron en día y noche, en ambos tamaños:
`comparacion-after-reportes-{dia,noche}-{1440,360}-30.png`.
Ambos lados se muestran a escala 0,5 en escritorio y 1:1 en móvil; las imágenes
son de página completa. Las capturas individuales conservan resolución nativa.

## Hallazgos y correcciones

1. **P2 · gráfica sin contexto.** Barras pequeñas sin fechas ni escala, con
   una altura mínima incluso para cero. Se reemplazan por series diarias con
   eje desde cero, leyenda, trazo discontinuo para resueltas, selector de día
   por teclado y tabla. Las fechas faltantes se completan con cero real.
2. **P2 · todas las cifras pesaban igual.** Se priorizan conversaciones,
   resueltas, pendientes y primera respuesta. Cierres tienen un anillo con
   cantidades explícitas; oportunidades, su propia evolución. Los recursos
   permanecen disponibles y cada definición puede abrirse sin depender de hover.
3. **P2 · montos partidos en móvil durante la primera iteración.** La tarjeta
   de pagos ahora ocupa el ancho móvil y el anillo comercial cede espacio a
   las cifras. Revisión final: $4.850.000 y $2.790.000 íntegros a 360 px.
4. **P1 · respuesta anterior bajo otro rango o negocio.** Peticiones cancelables,
   memoria limitada a vista/sesión/negocio y descarte de respuestas fuera de
   contexto. Revalidación visible y recuperación de errores. Los tests cubren
   respuestas desordenadas y limpieza de datos al perder permisos.

Tipografía Outfit/Inter/mono, colores semánticos, material jelly, radios y
marca siguen Pulso Vivo. Aumentan la jerarquía y el espacio útil de las gráficas;
no cambian acciones de negocio. El contenido se apila en móvil sin overflow
horizontal. El scroll vertical de un reporte con varias secciones es deliberado;
no se modifica el ajuste de altura del login.

## Validación y límites

- 12 vistas finales: rangos 7/30/90, dos modos y dos anchos, sin excepciones
  JavaScript ni desbordes horizontales. Capturas anteriores equivalentes.
- 63 E2E aprobados, cinco capturas opcionales omitidas. Incluyen navegación,
  candados sin duplicados, cargas paralelas, teclado, tenant, errores, tablas,
  campañas, bandeja y ajuste de altura del acceso. OTP simulado.
- UI: 49 tests; web: 58; analytics: 19; API de analytics: 2. Build de 30 tareas,
  tipos de 54 tareas, lint y fronteras de módulos aprobados.
- Las capturas y medidas por pestaña usan fixtures. La comparación de SQL sí
  usa staging, con lectura acotada y sin mutaciones. Sus límites y las muestras
  están en `docs/evidencias/424/README.md`. No se simula trabajo para demorar UI.
- Se conservan las definiciones y el porcentaje redondeado de la API; no se
  presenta cierre como embudo de las conversaciones recién creadas.

Verificación de imagen desplegada, salud y navegador de staging: se añade al
PR después del merge. Esta revisión no certifica accesibilidad de todo el producto.

---

# Colorimetría fresca de IAxTi · revisión #408

**final result: passed** — no quedan hallazgos visuales P0/P1/P2 en el alcance
revisado. Se conserva la composición y se renueva la paleta compartida.

## Fuente y evidencia

Solicitud del usuario: una paleta fresca, menos opaca, conservando el diseño.
Dirección definida en `docs/diseno/paleta.md` y ADR-0022. El azul de marca se
conserva; cian luminoso, mandarina y superficies azules reemplazan el matiz gris.

Fuente visual: build de staging `4860dbd`, con fixtures locales sintéticos.
Capturas `docs/evidencias/408/before-*.png`; implementación final en
`after-*.png`, con la misma ruta, datos, modo y viewport. El muestrario
`paleta.png` extrae colores directamente de los tokens.

Comparaciones conjuntas abiertas y revisadas:

- `comparacion-after-inicio-noche-1366.png`: inicio nocturno.
- `comparacion-after-login-dia-1366.png`: login diurno.
- `comparacion-after-login-noche-360.png`: login móvil nocturno a escala 1:1.

Capturas fuente/implementación: 1366×768 y 360×640 píxeles, CSS al mismo tamaño,
densidad 1 y movimiento reducido. Los tableros de escritorio muestran ambos
lados a 0,5; el móvil permite inspeccionar tipografía, campos, bordes y SVG
sin otro recorte. Capturas individuales de escritorio conservan tamaño completo.

## Hallazgos y decisiones

1. **P2 · superficies apagadas.** La fuente usa casi negro y grises fríos.
   Se cambian a blanco azulado en día y azul profundo con paneles distinguibles
   en noche. Se reduce el peso de las sombras nocturnas conservando geometría.
2. **P1 · foco al iluminar fondos.** Usar el relleno de marca como anillo no
   permite elevar la luminosidad de los paneles y conservar contraste de foco.
   Se introduce `--focus`, común a outline, borde y rings. La nueva guarda
   exige 3:1 sobre nueve superficies; el E2E comprueba el color renderizado.
3. **P2 · hover y placeholder.** Se recalibran y se agregan a las guardas.
   El texto blanco sobre hover nocturno alcanza 4,71:1; sobre acción, 5,13:1.

Primera comparación: las diferencias cromáticas anteriores son el objetivo
de la corrección. La propuesta con tokens en el navegador mantiene la
composición; la revisión posterior sobre build real confirma el mismo resultado.
No hubo ajustes de geometría para aceptar la nueva paleta.

Los cinco aspectos revisados: Outfit/Inter/mono y sus tamaños se conservan;
espacios, radios y posiciones no cambian; los colores son los roles definidos;
el SVG original mantiene nitidez con reflejos cian; copy, estados y acciones
siguen siendo los del producto. Las diferencias cromáticas son intencionales.

## Validación y límites

- 36 vistas del build real: nueve superficies en dos modos y dos tamaños.
  Login, inicio, bandeja, contactos, canales, formulario de IA, admin,
  login de admin y webchat. Sin excepciones JavaScript ni overflow horizontal;
  dimensiones del documento idénticas antes/después. Los logins caben completos.
- 47 tests UI, incluidas 24 pruebas de contraste. `contraste.json` recoge 102
  pares de texto, estados, hover, placeholder, límites de campo y foco.
- 56 E2E aprobados, tres capturas opcionales omitidas. Incluyen el login a
  distintas alturas, teclado, tablas, campañas, onboarding y bandeja real.
- Build de 30 tareas, tipos de 54 tareas, lint y fronteras de módulos aprobados.
- La revisión visual usa fixtures; OTP se simula en E2E. La suite de negocio
  usa API/PostgreSQL/Redis locales. No se acredita entrega a proveedores.

La verificación de la imagen exacta, salud y paleta en staging se registra en
el PR después del merge. Los contrastes comprobados no son una certificación
de accesibilidad de todo el producto.

---

# Acceso completo según ancho y altura · revisión histórica #406

**final result: passed** — el login inicial cabe en los tamaños revisados;
formularios y mensajes conservan acceso mediante scroll en alturas extremas.

La revisión #404 comprobó ancho, pero sus capturas de 1.000 px de alto no
detectaron el desborde vertical reportado por el usuario. Su informe histórico
se conserva más abajo; «cero desbordes» allí se refiere al eje horizontal.

## Fuente, comparación y alcance

- Fuente: login de staging en `a40ab4d`, antes de esta corrección. Capturas
  `docs/evidencias/406/before-app-1366x768.png` y `before-app-360x640.png`.
- Implementación: build standalone real de web y admin. Capturas
  `after-app-1366x768-dia-inicial.png`, `after-app-360x640-dia-inicial.png` y
  sus versiones nocturnas en el mismo directorio.
- Comparaciones conjuntas abiertas y revisadas: `comparacion-1366.png` y
  `comparacion-360.png`. Mismo viewport CSS, sesión cerrada, estado inicial,
  día, densidad 1. Las capturas son de 1366×768 y 360×640 píxeles. La tabla
  de notebook usa escala 0,5 en ambos lados; la de móvil conserva 1:1 y
  permite leer los campos, tipografía, foco y marca sin otro recorte.
- Se conserva la dirección Pulso Vivo aprobada. La diferencia intencional es
  adaptar proporciones y ceder texto decorativo cuando falta altura.

## Hallazgos e iteraciones

1. **P1 · contenido bajo el borde del navegador.** Antes: 900 px de contenido
   en 1366×768; 920 px en 360×640. Cabecera/pie y arte tenían espacios pensados
   solo para pantallas altas. Corrección: reglas de altura, márgenes menores,
   SVG adaptable y distribución móvil con grid en lugar del float.
2. **P2 · marca y modo en administración.** El botón podía partirse en dos
   líneas. Corrección: marca flexible y botón sin quiebre, con alto mínimo de
   46 px. Evidencia: `after-admin-360x640-noche-inicial.png`.
3. **P1 · primer ajuste insuficiente al mostrar avisos.** El estado inicial
   cabía, pero código vencido seguía desbordando en notebooks. Corrección:
   dar espacio al aviso reduciendo separaciones y contenido introductorio
   redundante, sin ocultar instrucciones ni acciones del formulario.
   Evidencia: `after-app-360x640-noche-codigo-malo.png` y E2E del código vencido.
4. **P2 · saltos entre reglas.** Se probaron también alturas 741, 900 y 961;
   se amplió el rango compacto y se mantuvo la composición de avisos fuera
   de ese rango. Los E2E de esas fronteras ahora pasan.

La comparación posterior muestra ambos botones, campos y pie dentro de la
ventana. Se revisaron los cinco aspectos: Outfit/Inter/mono y lectura se
conservan; espacios y tamaños responden a altura; colores y tokens no cambian;
el SVG oficial mantiene nitidez; texto y funciones de autenticación no cambian.
El copy decorativo se reduce en móvil corto y ante avisos de autenticación.

## Verificación y límites

- Build: 30 tareas; tipos: 54 tareas; lint y fronteras de módulos aprobados.
- UI: 39 tests, incluidas las 16 comprobaciones de contraste existentes.
- E2E: 56 aprobados, tres capturas opcionales omitidas; 23 casos del acceso.
  Incluyen los dos modos, 11 tamaños, error de envío, código enviado/vencido,
  reintento, persistencia de modo, teclado y viewport horizontal/reducido.
- Las guardas comprueban scroll vertical y horizontal, posición del pie y
  controles, ausencia de desplazamiento y 46 px en campos/acciones principales.
- Los avisos largos en una pantalla horizontal de 390 px de alto, el zoom y
  el teclado virtual pueden necesitar scroll: se conserva deliberadamente
  para permitir leer y operar. No se usa altura fija, zoom CSS ni recorte del
  formulario. La prueba de 360×320 comprueba controles y pie alcanzables.
- OTP se simula en las pruebas; no se enviaron correos ni se cambió el proveedor.
  La suite del resto del producto usa API, PostgreSQL y Redis locales reales.

La salud e imagen exacta de staging se documentan en el PR tras el merge.

---

# Pulso Vivo · revisión visual histórica #404

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
