# Inventario de estados vacíos (criterio 3 de #1326)

Qué dice cada pantalla principal cuando no hay nada. La regla que este
inventario protege: **un estado vacío por pantalla**, y cuando algo no puede
funcionar, la pantalla no invita a usarlo.

Revisadas las ocho pantallas principales (el resto de los estados vive en
`EstadoVacio` de cada lista y lo cubre la guarda de «listas sin vacío»).

| Pantalla | Estado vacío | ¿Se contradice con algo a la vista? |
|---|---|---|
| **Bandeja** (lista) | «Todavía no te escribe nadie» + conectar WhatsApp | — |
| **Bandeja** (panel derecho) | «Cuando un cliente escriba, su conversación abre acá» (#1326) | Ya no: antes pedía «elige una conversación» con la lista vacía |
| **Tu asistente** | Señal roja si la IA no puede + campo `readOnly` y botón apagado (#1326) | Ya no: antes el chat invitaba a pedir con la IA rota |
| **Oportunidades** | Tablero con columnas aunque no haya deals; «Arrastra una oportunidad acá» en cada vacía | — (una columna vacía INVITA porque el gesto es el que la llena) |
| **Agenda** | «Todavía no hay horas agendadas» + cómo se llenan | — |
| **Contactos** | Lista vacía con acción de crear | — |
| **Empresas** | «Todavía no hay empresas» | — |
| **Ajustes · IA** | `PorQueLaIaNoTrabaja`: el diagnóstico completo con qué falta | — (es EL detalle de la señal) |

## Los dos arreglados en #1326

1. **Bandeja**: `Chat` recibe `listaVacia` y el panel derecho cambia su
   mensaje según haya o no lista de donde elegir. La prueba
   (`un-estado-vacio-por-pantalla.test.tsx`) monta los dos estados y lee lo
   que dicen.
2. **Tu asistente**: el diagnóstico vive en `ProveedorAgente` (`iaRota`) y
   lo leen la señal Y el campo. Con la IA rota el texto no entra y el botón
   «Pedir» está apagado. La prueba escribe en el campo con la IA rota y
   espera que no quede nada.

## Regla para el futuro

Nueva pantalla = decidir su estado vacío JUNTO con su estado lleno. Si el
cartel que un panel muestra puede volverse falso por el contenido de otro
panel de la misma pantalla, el estado lo decide la pantalla, no el panel.
