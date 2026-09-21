# Regla: seguridad

- Autorización SIEMPRE: `@RequireModule` + `@RequirePermission` + verificación
  de tenant + dueño/equipo del objeto cuando aplica. PROHIBIDO
  `if (user.role === '...')` — el grep de CI lo caza.
- RLS es la segunda cerradura, no la primera: toda tabla de negocio lleva
  `tenant_id` y política; toda conexión fija `app.tenant_id`. Un test por
  módulo prueba que el tenant A no ve filas del tenant B.
- Toda mutación importante escribe en `audit_log` EN LA MISMA transacción:
  actor, actor_kind, tenant, action, resource, resource_id, ip, user_agent,
  result, request_id, metadata. Acciones de agentes agregan `on_behalf_of` y
  `execution_id`.
- Secrets: variables de entorno (Dokploy / GitHub Environments). Nada en Git,
  nada en el compose, nada en logs. Gitleaks corre en pre-commit y CI. Un
  secreto expuesto se rota el mismo día (SECURITY_BASELINE.md).
- Webhooks entrantes: verificar firma con comparación timing-safe sobre el raw
  body, encolar, responder < 1 s, idempotencia por id del proveedor. Nunca
  procesar en línea.
- Tokens OAuth de Google: almacén cifrado, nunca en la base; scopes mínimos e
  incrementales; cada acceso a datos de Google queda en audit.
- Tools de IA: pasan por el mismo guard con la identidad del usuario que
  conversa; ninguna tool borra; ninguna tool cruza tenants.
- PII: minimizar en logs; redactar antes de Langfuse o cualquier proveedor
  LLM; proveedores en **tier pago allí donde pasan datos de clientes** —
  producción siempre. En staging se admite el tier gratis mientras ahí solo
  haya datos de prueba (ADR-0011, enmienda). OJO: hoy staging está conectado
  al número real de VoxTi porque Zavu no ofrece sandbox, así que ese "solo
  datos de prueba" es una condición aceptada a sabiendas y se revisa con el
  primer cliente real.
- Si el PR toca auth, datos personales, tools o webhooks: `/security-review`
  antes de pedir merge, y actualizar la fila en COMPLIANCE_BASELINE.md.
