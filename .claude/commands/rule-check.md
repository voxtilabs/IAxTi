---
description: Verifica las reglas transversales de negocio en el diff
---

Sobre el diff actual (o `$ARGUMENTS`), contra `.claude/rules/negocio.md`:

1. ¿Algún envío iniciado por el negocio puede salir en horario de silencio?
   Busca el punto donde se difiere; si no existe, es un hallazgo.
2. ¿Algún envío libre posible fuera de la ventana de 24 h? ¿La API lo rechaza
   o solo la UI?
3. ¿Se verifica consentimiento antes de todo envío iniciado por el negocio?
   ¿El opt-out automático ("BASTA", "STOP") sigue funcionando con este cambio?
4. ¿Alguna ruta por la que la IA pueda afirmar precio, stock, plazo o
   compromiso sin tool que lo confirme?
5. ¿Algo se borra físicamente desde un flujo de interfaz? (solo archivo;
   borrado real = titular o retención §39)
6. ¿Reasignaciones dejan rastro? ¿Un dueño por conversación/oportunidad?
7. ¿Los costos que este cambio genera (Meta, IA) quedan visibles para el
   tenant?

Reporta con archivo:línea, la regla violada y el arreglo.
