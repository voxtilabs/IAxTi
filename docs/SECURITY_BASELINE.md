# Baseline de seguridad

Lo que la plataforma hace y cómo se opera. Cada control referencia el ADR o la
sección del SPEC que lo define. Estado: `pendiente` hasta que el issue que lo
implementa se cierre; entonces se anota el PR.

## Identidad y acceso

| Control | Implementación | Referencia | Estado |
|---|---|---|---|
| Autenticación de usuarios | Supabase Auth: Google OAuth + enlace mágico; contraseña opcional | ADR-0002, #7 | pendiente |
| MFA | Obligatorio para ADMIN y SUPERADMIN desde el segundo usuario del tenant | SPEC §9, #7 | pendiente |
| Bloqueo por fuerza bruta | 5 intentos fallidos → 15 min de bloqueo + aviso al ADMIN | SPEC §9, #7 | pendiente |
| Autorización | Guard módulo+permiso+tenant+objeto; roles como paquetes; sin `if (role)` | ADR-0008, #9 | pendiente |
| RLS | `SET app.tenant_id` por conexión; política en toda tabla de negocio | ADR-0008, #4 | pendiente |
| API keys | Scopes, hash en base, expiración, último uso, `actor_kind = apikey` | #24 (F5) | pendiente |
| Cuota de API por tenant | `api_requests_month` por plan + override; 429 estándar | #25 (F5) | pendiente |

## Datos

| Control | Implementación | Referencia | Estado |
|---|---|---|---|
| Cifrado en tránsito | TLS en Traefik y Cloudflare; HTTPS interno a Supabase | ADR-0003 | pendiente |
| Cifrado en reposo | Supabase (Postgres) y R2 cifran en reposo | ADR-0002 | pendiente |
| Secrets | Variables de entorno en Dokploy y GitHub Environments; nada en Git; Gitleaks en CI | SPEC §36 | pendiente |
| Tokens OAuth de Google | Secret Manager/almacén cifrado, nunca en la base; scopes mínimos; revocación desde la app | SPEC §18 | pendiente |
| Backups | Supabase PITR (RPO 5 min); Redis diario a R2; restore probado cada mes (RTO 1 h) | ADR-0002, #80 | pendiente |
| Adjuntos | R2 por tenant; los de WhatsApp se descargan al llegar; nunca en Postgres | SPEC §40 | pendiente |
| Borrado y retención | Sección 39: archivo no borra; retención por plan; solicitud del titular aparte | ADR-0012 | pendiente |

## Plataforma

| Control | Implementación | Referencia | Estado |
|---|---|---|---|
| Borde | Cloudflare: proxy, WAF gestionado, rate limit /api/* y /webhooks/* | #16 | pendiente |
| Acceso administrativo | Cloudflare Access para panel Dokploy y admin staging; SSH solo con llave desde IP autorizada; VPS solo 80/443 desde rangos CF | #16 | pendiente |
| Webhooks entrantes | Firma verificada (HMAC), encolado, idempotencia por id, respuesta < 1 s | SPEC §12, #41 | pendiente |
| Webhooks salientes | HMAC por endpoint, secreto rotable, panel de entregas | #76 (F5) | pendiente |
| Rate limiting | Por tenant y por API key en Redis, cabeceras estándar | #12 | pendiente |
| Audit | Append-only, hash encadenado por tenant, misma transacción, sin UPDATE/DELETE | ADR-0008, #10 | pendiente |
| CI de seguridad | CodeQL, Gitleaks, Trivy (imagen); Semgrep y ZAP con usuarios reales | SPEC §37 | pendiente |
| Dependencias | Dependabot semanal; lockfile en CI | SPEC §28 | pendiente |

## IA

| Control | Implementación | Referencia | Estado |
|---|---|---|---|
| El LLM nunca toca la base | Solo tools autorizadas con la identidad del usuario, mismo guard | ADR-0008, #47 | pendiente |
| Aislamiento de tenant en IA | Contexto solo de la conversación actual; RLS en pgvector | SPEC §13, #51 | pendiente |
| PII hacia proveedores | Redacción antes de Langfuse y de cualquier proveedor LLM, según política del tenant | ADR-0006, ADR-0011 | pendiente |
| Tier de proveedores | Solo APIs de pago con opt-out de entrenamiento verificado | ADR-0011, #54 | pendiente |
| Guardrails del autónomo | Escalamiento, topes de dinero, horario de silencio, sin inventar datos | ADR-0010, #49 | pendiente |

## Rotación y respuesta

- Rotación de secretos documentada por secreto (Dokploy, GHCR, Zavu, Gemini,
  Supabase, pasarela): al comprometerse, al salir una persona, o cada 6 meses.
- Un token pegado en un chat o log se considera comprometido y se rota ese día.
- Incidentes: registrar en un issue `type:security`, línea de tiempo en el
  cuerpo; si hay datos personales, evaluar notificación según Ley 21.719
  (ver COMPLIANCE_BASELINE.md).
