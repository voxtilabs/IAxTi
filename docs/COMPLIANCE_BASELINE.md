# Baseline de compliance

Tres cosas distintas que no se confunden (SPEC §30):

1. **Preparación técnica** — lo que el código hace. Se rastrea aquí.
2. **Certificación formal** — ISO 27001/27701/42001: políticas, responsable,
   evidencia, auditoría externa. Meses. No es código.
3. **Cumplimiento legal** — Ley 21.719: base de licitud, derechos del titular,
   contratos de tratamiento, notificación de brechas.

**Nunca se afirma "cumple ISO" en el producto ni en material comercial.** La
arquitectura es auditable; la certificación es un proceso aparte.

Cada feature que toque datos personales o IA actualiza su fila. Tipo:
técnico (T) / organizacional (O) / legal (L) / contractual (C).

| Control | ISO 27001 | ISO 27701 | ISO 42001 | OWASP ASVS | Ley 21.719 | Implementación | Tipo | Estado |
|---|---|---|---|---|---|---|---|---|
| Control de acceso por roles y permisos | A.5.15, A.8.3 | 6.2 | — | V4 | art. seguridad | ADR-0008, #9 | T | pendiente |
| MFA para administradores | A.5.17 | — | — | V2.8 | — | #7 | T | pendiente |
| Aislamiento multi-tenant (guard + RLS) | A.8.3 | 6.4 | — | V4.2 | deber de secreto | #4, #9 | T | pendiente |
| Auditoría append-only con integridad | A.8.15 | 6.9 | 8.4 | V7 | evidencia | #10 | T | pendiente |
| Cifrado en tránsito y reposo | A.8.24 | 6.5 | — | V9 | seguridad | ADR-0002/0003 | T | pendiente |
| Gestión de secretos y rotación | A.8.24 | — | — | V6 | — | SECURITY_BASELINE | T/O | pendiente |
| Backups y restore probado | A.8.13 | — | — | — | disponibilidad | #80 | T/O | pendiente |
| Minimización de PII en logs y trazas | A.8.11 | 6.11 | 8.2 | V8 | proporcionalidad | ADR-0006 | T | pendiente |
| Redacción de PII hacia proveedores de IA | — | 6.11 | 8.2, 9.2 | — | transferencia | ADR-0011, #54 | T/C | pendiente |
| Transferencia internacional (Supabase, Gemini, Zavu, GLM si se adopta) | A.5.19 | 7.5 | — | — | transferencia internacional | contratos + fila por proveedor | L/C | pendiente |
| Consentimiento y opt-out registrado | — | 7.2 | — | — | base de licitud | #30 (evidencia opt-in) | T/L | pendiente |
| Derecho de acceso y portabilidad | — | 7.3 | — | — | derechos del titular | exportación total del tenant | T | pendiente |
| Derecho de supresión | — | 7.3 | — | — | derechos del titular | borrado por solicitud, registrado, todos los módulos | T | pendiente |
| Retención definida y aplicada | A.8.10 | 7.4 | — | — | limitación del plazo | ADR-0012, #77 | T | pendiente |
| Notificación de brechas | A.5.24-26 | — | — | — | notificación | procedimiento en SECURITY_BASELINE | O/L | pendiente |
| Contrato de tratamiento con cada cliente | — | 8 | — | — | encargado | plantilla legal (#81) | L/C | pendiente |
| Transparencia de la IA ante el usuario final | — | — | 8.3 | — | — | "respondió el asistente" + pedir humano (#49) | T | pendiente |
| Supervisión humana de la IA | — | — | 8.4, 9.4 | — | — | ADR-0010: assist por defecto, escalamiento | T | pendiente |
| Registro y explicación de acciones de IA | — | — | 8.4 | — | — | Execution + explicación en ficha (#47) | T | pendiente |
| Evaluación continua de agentes | — | — | 9.2 | — | — | #53: dataset, judge, gate | T | pendiente |
| Cuotas y límites de uso de IA | — | — | 8.2 | — | — | #52 | T | pendiente |
| Inventario de datos personales por módulo | — | 6.1 | — | — | registro de actividades | se genera desde los manifiestos + esquema | T/O | pendiente |

Las referencias a cláusulas ISO/ASVS son orientativas para ordenar el trabajo;
la numeración exacta se valida con el auditor cuando la certificación empiece
(Fase 6, #81).
