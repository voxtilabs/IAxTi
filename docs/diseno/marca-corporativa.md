# Firma corporativa VoxTiLabs · #427

La firma usa la geometría oficial y los reflejos del lockup vectorial que
VOXIA 2 renderiza como `voxti-glass-tinta.svg` y `voxti-glass-claro.svg`.
Referencia: `app/static/assets` del proyecto VOXIA 2, compartido por el usuario.
La forma y las letras son las mismas que ya empleaba IAxTi; cambia el acabado
del isotipo plano a volumen con luces y reflejos estáticos.

En IAxTi se aplica mediante `packages/ui/marca/voxti-jelly-tokens.svg` y su
copia inline en `marca-svg.ts`. Los colores del material usan los tokens
`--jelly-*` y `--action`; las letras usan `--text` y `--text-muted`, de modo que
la firma conserva contraste en día y noche. El sidebar deja de atenuarla al 70 %.
No cambia su altura, el espacio del login ni la identidad del producto IAxTi.

`useMarcaSvg` asigna IDs por instancia con `useId`: el acceso de administración
muestra dos firmas y sus gradientes/filtros no deben resolver contra otra copia.
Solo procesa SVG versionado. No carga imágenes, scripts ni contenido del usuario.
El favicon de administración usa el isotipo original autónomo `voxti-glass.svg`;
los archivos planos siguen disponibles para usos de marca que los necesiten.

Esto aplica ADR-0021/0022; no introduce un sistema visual alternativo ni modifica
flujos, permisos o APIs. Las capturas antes/después y la revisión de referencias
SVG se encuentran en `docs/evidencias/427/`.
