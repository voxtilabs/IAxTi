# Regla: negocio (transversales que el código debe imponer)

- **Ventana de 24 h de WhatsApp:** dentro de 24 h desde el último mensaje del
  cliente, respuesta libre; fuera, SOLO plantilla aprobada. La bandeja lo
  muestra y bloquea; la API lo rechaza aunque la UI falle.
- **Horario de silencio** (21:00–8:00 por defecto, configurable, no
  desactivable): NADA iniciado por el negocio se envía — recordatorios,
  seguimientos, plantillas, campañas. Se difiere al siguiente horario válido.
  Responder a un cliente que escribió sí se puede.
- **Consentimiento:** mensajes iniciados por el negocio solo si el contacto
  escribió primero o dio opt-in registrado (fecha, canal, evidencia). "BASTA",
  "STOP", "no me escriban" y equivalentes → opt-out automático e inmediato.
  Importados por CSV nacen SIN opt-in.
- **Horario hábil** define cuándo la IA asiste y cuándo puede actuar sola.
- **Un dueño** por conversación y por oportunidad; reasignar deja rastro.
- **Nada se borra desde la interfaz:** se archiva. Borrado real solo por
  solicitud del titular o política de retención (SPEC §39), auditado.
- **La IA nunca** inventa precio, stock, plazo ni descuento; nunca afirma lo
  que una tool no confirmó; escala según las reglas de ADR-0010.
- **Costos visibles:** Meta e IA por tenant en tiempo real, en pesos, en mono.
  Sin margen escondido sobre los costos de Meta.
- Zona horaria del tenant (defecto America/Santiago); UTC en la base.
  Teléfonos E.164. RUT validado con DV, opcional. CLP por defecto; UF con
  valor del día registrado.
- Verificación: `/rule-check` en todo PR que toque envíos, automatizaciones o
  IA. El reviewer-negocio revisa estos puntos en cada PR.
