# Campañas · #348

Capturas de una vista previa con dos contactos sintéticos, sobre la aplicación
compilada y la API real local. Los tests no levantan workers ni contactan al
proveedor: verifican que el envío queda en cola.

- [Día, 360 px](previa-dia-360.png).
- [Noche, 360 px](previa-noche-360.png).

Playwright verifica creación, plantilla aprobada, conteo y muestra, rechazo por
calidad roja y por caída de calidad durante la revisión, plan en solo lectura,
idempotency key, motivos de omisión, foco y ausencia de scroll horizontal.

Reproducir con PostgreSQL y Redis locales: `pnpm build` seguido de
`node apps/web/e2e/run-e2e.mjs`.
