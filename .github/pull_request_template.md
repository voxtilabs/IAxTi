Closes #

## Qué cambia


## Checklist (SPEC §34 — borra las filas que no aplican, no las ignores)

- [ ] El cambio vive en un módulo o cruza solo por contract.ts y eventos
- [ ] Endpoints nuevos con @RequireModule + @RequirePermission + OpenAPI
- [ ] Mutaciones importantes escriben en audit_log en la misma transacción
- [ ] tenant_id + política RLS en toda tabla nueva; migración aditiva
- [ ] Tests de los criterios de aceptación (+ combinación si toqué manifiesto)
- [ ] Tools nuevas pasan por el guard con identidad del usuario y no borran
- [ ] Respeta ventana de 24 h, horario de silencio y consentimiento
- [ ] La IA no puede inventar precio/stock/plazo/compromiso con este cambio
- [ ] Sin hex suelto, sombra, gradiente ni emoji; capturas en día y noche
- [ ] Sin secrets, tokens ni URLs internas en el diff
- [ ] ADR creado/actualizado si hubo decisión; compliance al día
