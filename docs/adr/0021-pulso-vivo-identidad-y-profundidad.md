# ADR 0021 · Pulso Vivo: identidad y profundidad para IAxTi

**Estado:** aceptada por instrucción del usuario · 2026-09-21 · #404

## Contexto

El usuario pide extender a todo IAxTi el lenguaje visual de VOXIA 2, con
personalidad propia, material jelly y profundidad, manteniendo las funciones
existentes. La prohibición absoluta de efectos de Pulso impide ese objetivo.

## Decisión

Pulso Vivo conserva el azul de acción, las familias tipográficas, los tokens
semánticos, los dos modos, los estados y los componentes. Añade material SVG
al isotipo oficial de IAxTi, relieves suaves y ambiente estático en acceso y
encabezados. La geometría, las rutas y el contenido de VOXIA no se copian.

Reemplaza parcialmente ADR-0009 (prohibición de efectos y ausencia de marca
propia) y ADR-0018 (elevación exclusiva de overlays). Los valores viven en
`pulso-tokens.css`; su aplicación, en `pulso-vivo.css`. Los overlays mantienen
`--elevacion-flotante`, diferente de la elevación de superficies. No se
admiten efectos arbitrarios por pantalla ni clases `shadow-lg` del registro.

Se conservan permisos, contratos, acciones y datos. No se agregan métricas,
funciones aparentes ni controles sin respaldo. SVG decorativos con IDs únicos,
sin recursos externos, WebGL ni bucles de animación. Contraste AA, foco visible,
movimiento reducido, ambas apariencias y 360 px son condiciones del cambio.

## Consecuencias

Una misma capa visual alcanza cliente, administración, acceso y webchat. El
producto gana identidad y separación de superficies; se acepta más CSS y un
pequeño SVG por pieza de marca. Las capturas y la regresión funcional se
verifican antes del merge y el despliegue se comprueba en staging.

## Se revisa cuando

Una pantalla pierde legibilidad, rendimiento o consistencia por los efectos,
o se necesita un valor visual fuera de los tokens compartidos.
