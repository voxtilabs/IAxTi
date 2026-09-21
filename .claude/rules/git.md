# Regla: git y PRs

- Nada se construye sin Issue. Rama: `feat|fix|chore/<issue>-<slug>` desde
  `staging`, y el PR va contra `staging` (ADR-0019). Sin develop, sin
  release/*.
- Commits y títulos de PR en conventional commits (`feat:`, `fix:`, `chore:`,
  `feat!:`); el changelog se genera de los títulos. Semver: fix → patch,
  feat → minor, feat! o ADR que rompe contrato → major.
- El PR: título conventional, cuerpo con "Closes #n", checklist de abajo
  rellenado, capturas en día Y noche si hay UI.
- Squash a `staging`, que es lo que corre en el ambiente de staging.
- Promoción a `main` con `git merge --ff-only staging`. Conservar los SHA NO
  es estilo: `release.yml` promueve la imagen del commit exacto que se
  taguea y falla si no existe. Un merge commit nuevo no tiene imagen.
- **Nada entra a `main` sin pasar por `staging`**, hotfix incluido: si main
  se adelanta, el siguiente ff-only falla y la promoción se vuelve un merge.
- Main siempre desplegable: lo no listo se esconde con flag.
- Hotfix: rama desde main, mismo camino, sin atajos.
- Checklist antes de cualquier PR (SPEC §34):
  1. ¿El cambio vive en un módulo o cruza solo por contract.ts y eventos?
  2. ¿Todo endpoint nuevo tiene @RequireModule, @RequirePermission y OpenAPI?
  3. ¿Toda mutación importante escribe en audit_log en la misma transacción?
  4. ¿Hay tenant_id y política RLS en toda tabla nueva?
  5. ¿La migración es aditiva y versionada?
  6. ¿Hay tests, incluido el de combinación si tocaste un manifiesto?
  7. ¿Toda tool nueva pasa por el guard con la identidad del usuario y no borra?
  8. ¿Respeta ventana de 24 h, horario de silencio y consentimiento?
  9. ¿La IA puede inventar precio, stock, plazo o compromiso con este cambio?
  10. ¿Algún hex suelto, efecto fuera de Pulso Vivo (ADR-0021) o emoji en la interfaz?
  11. ¿Se ve bien en día y noche, a 360 px, con foco visible, montos en mono?
  12. ¿Algún secret, token o URL interna en el diff?
  13. ¿Existe el ADR si la decisión es importante? ¿Compliance al día?
  14. ¿El PR referencia su issue y el título sigue conventional commits?
