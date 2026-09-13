---
description: Verifica que el diff respeta el sistema de módulos
---

Sobre el diff actual (o `$ARGUMENTS`):

1. Imports: ¿algún archivo importa de otro módulo sin pasar por su
   `contract.ts`? ¿`packages/core` importa de algún módulo? Corre
   `pnpm dependency-cruiser` si está configurado; si no, revísalo a mano.
2. Manifiestos tocados: ¿permisos/eventos/tools declarados coinciden con lo
   que el código usa? ¿depends_on refleja los imports reales?
3. ¿Endpoints nuevos con `@RequireModule`? ¿Jobs que verifican módulo activo?
   ¿Tools registradas condicionalmente?
4. ¿Dependencias opcionales por `capabilities.get()` con degradación real (no
   un throw)?
5. Si cambió un manifiesto: corre el test de combinación de módulos.

Reporta violaciones con archivo:línea y cómo corregirlas (qué agregar al
contrato, qué evento usar en vez del import).
