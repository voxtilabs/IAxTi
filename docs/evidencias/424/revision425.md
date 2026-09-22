# Comparación posterior con el PR #425

El usuario pidió comprobar si convenía adoptar el diseño de Lino o integrar
los datos adicionales que trajera. Se revisó `b6b5a57`, se compiló en un checkout
separado y se capturó con los mismos fixtures, fecha, tamaños y modos del PR #426.
No se modificó la rama de Lino.

El PR #425 sí modifica el diseño: añade escala, fechas, leyenda y tabla a las
barras. Es más compacto que #426. **No añade métricas ni fuentes de datos**:
consume las mismas conversaciones, resueltas y oportunidades del dashboard.
El seed de doce días que incorpora es exclusivamente para pruebas E2E.

Se mantiene #426 porque da mayor jerarquía a las gráficas, distingue las series,
permite selección por teclado y presenta cierres y oportunidades por separado.
La tabla y las fechas ya están incluidas. Las comparaciones conjuntas adjuntas
se abrieron y revisaron en escritorio diurno y móvil nocturno.

Hallazgos comprobados en #425:

- `bg-good` no está definido como color de fondo en el preset: la leyenda y
  los segmentos de resueltas tienen `background-color: rgba(0, 0, 0, 0)`.
- Las resueltas se limitan al alto de conversaciones nuevas. Según
  `DEFINICIONES.resueltas`, son cierres del período, que pueden corresponder a
  conversaciones anteriores; no constituyen necesariamente un subconjunto.
- Al volver a un rango en caché no se incrementa el contador de petición.
  Reproducción con datos sintéticos: cargar 30 días (300), pedir 7 reteniendo
  su respuesta, volver a 30, liberar la de 7 (700). #425 muestra **700 con la
  pestaña de 30 seleccionada**. #426 conserva 300. `revision425.json` registra
  ambos resultados, obtenidos sobre builds reales con la respuesta controlada.

El ajuste de `outputFileTracingRoot` de #425 aborda portabilidad del build y
es independiente del diseño. No se fusiona todo #425 para incorporar esa parte;
queda disponible para separarla sin reemplazar el reporte validado.
