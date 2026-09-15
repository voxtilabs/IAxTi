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
| Control de acceso por roles y permisos | A.5.15, A.8.3 | 6.2 | — | V4 | art. seguridad | ADR-0008, #9 | T | hecho — guard único, ADR-0008; el CI falla si aparece un `if (role)` |
| MFA para administradores | A.5.17 | — | — | V2.8 | — | #7 | T | **pendiente** — Supabase Auth está, el segundo factor no |
| Aislamiento multi-tenant (guard + RLS) | A.8.3 | 6.4 | — | V4.2 | deber de secreto | #4, #9, #211 | T | hecho, **con una condición**: Postgres no evalúa las políticas si el rol que conecta es superusuario o tiene BYPASSRLS. La aplicación comprueba eso al arrancar y en producción se niega a servir si no se cumple (#227). En Supabase el rol `postgres` tiene BYPASSRLS: el runbook exige un rol de aplicación aparte |
| Auditoría append-only con integridad | A.8.15 | 6.9 | 8.4 | V7 | evidencia | #10 | T | hecho — hash encadenado, trigger anti UPDATE/DELETE, explorador y export firmado (#72) |
| Cifrado en tránsito y reposo | A.8.24 | 6.5 | — | V9 | seguridad | ADR-0002/0003 | T | hecho por proveedor — TLS y cifrado en reposo de Supabase, R2 y Cloudflare |
| Gestión de secretos y rotación | A.8.24 | — | — | V6 | — | SECURITY_BASELINE | T/O | parcial — todo por referencia y fuera de git; la rotación del cierre de construcción está pendiente |
| Backups y restore probado | A.8.13 | — | — | — | disponibilidad | #80 | T/O | **pendiente** — #80; el restore no se ha cronometrado nunca |
| Minimización de PII en logs y trazas | A.8.11 | 6.11 | 8.2 | V8 | proporcionalidad | ADR-0006 | T | hecho — ADR-0006; nada de cuerpos de mensaje en OTel |
| Redacción de PII hacia proveedores de IA | — | 6.11 | 8.2, 9.2 | — | transferencia | ADR-0011, #54 | T/C | hecho — `redactPII` en el runtime, encendido por defecto |
| Transferencia internacional (Supabase, Gemini, Zavu, GLM si se adopta) | A.5.19 | 7.5 | — | — | transferencia internacional | contratos + fila por proveedor | L/C | pendiente |
| Consentimiento y opt-out registrado | — | 7.2 | — | — | base de licitud | #30 (evidencia opt-in) | T/L | hecho — opt-in con evidencia y opt-out por palabra clave |
| Derecho de acceso y portabilidad | — | 7.3 | — | — | derechos del titular | del titular y del tenant | T | hecho — `GET /contacts/:id/titular` entrega todo lo de una persona (mensajes incluidos), y la exportación completa del negocio existe desde #222: sale con lo que dejó afuera y por qué, y jamás un secreto |
| Derecho de supresión | — | 7.3 | — | — | derechos del titular | borrado por solicitud, registrado, todos los módulos | T | hecho — motivo obligatorio; despersonaliza el contacto y borra el contenido en TODAS las tablas donde vivía, incluida la copia que quedaba en las ejecuciones de IA (#235). Lo que se conserva —audit, montos, medición— viaja escrito en el resultado y en el libro |
| Retención definida y aplicada | A.8.10 | 7.4 | — | — | limitación del plazo | ADR-0012, #77 | T | hecho — ADR-0012 y #77, con aviso previo al cambio de plan |
| Notificación de brechas | A.5.24-26 | — | — | — | notificación | procedimiento en SECURITY_BASELINE | O/L | parcial — el procedimiento está escrito; nunca se ha ensayado |
| Contrato de tratamiento con cada cliente | — | 8 | — | — | encargado | plantilla legal (#81) | L/C | **pendiente (legal)** — borrador a revisión de abogado; no lo resuelve el código |
| Transparencia de la IA ante el usuario final | — | — | 8.3 | — | — | "respondió el asistente" + pedir humano (#49) | T | hecho — se declara que respondió el asistente y se puede pedir humano |
| Supervisión humana de la IA | — | — | 8.4, 9.4 | — | — | ADR-0010: assist por defecto, escalamiento | T | hecho — ADR-0010: assist por defecto, autónomo es opt-in |
| Registro y explicación de acciones de IA | — | — | 8.4 | — | — | Execution + explicación en ficha (#47) | T | hecho — Execution con explicación en la ficha |
| Evaluación continua de agentes | — | — | 9.2 | — | — | #53: dataset, judge, gate | T | hecho — dataset de regresión que BLOQUEA el CI si baja del baseline |
| Cuotas y límites de uso de IA | — | — | 8.2 | — | — | #52 | T | hecho — umbrales al 80/100 % y pausa del modo autónomo |
| Análisis estático de seguridad (SAST) | A.8.28 | — | — | V14 | — | Semgrep en el CI (owasp-top-ten, typescript, secrets), BLOQUEA el PR | T | hecho |
| Análisis dinámico (DAST) | A.8.29 | — | — | V14 | — | OWASP ZAP baseline agendado contra staging (`.github/workflows/zap.yml`) | T | parcial — el workflow está; sin staging en pie no ha corrido (#133) |
| Transferencia internacional · Supabase (datos y auth) | A.5.19 | 7.5 | — | — | transferencia internacional | contrato del proveedor + región declarada | L/C | pendiente |
| Transferencia internacional · Google Gemini (IA) | A.5.19 | 7.5 | 8.2 | — | transferencia internacional | ADR-0011 + `redactPII` antes de salir | T/L/C | parcial — lo técnico está; el contrato no |
| Transferencia internacional · Zavu (canales) | A.5.19 | 7.5 | — | — | transferencia internacional | ADR-0014; el contenido de los mensajes pasa por el proveedor | L/C | pendiente |
| Transferencia internacional · Cloudflare R2 (adjuntos) | A.5.19 | 7.5 | — | — | transferencia internacional | adjuntos por tenant, URLs firmadas de vida corta | L/C | pendiente |
| Inventario de datos personales por módulo | — | 6.1 | — | — | registro de actividades | [INVENTARIO-DATOS.md](./INVENTARIO-DATOS.md) | T/O | hecho — qué guarda cada tabla, de quién es, si se exporta y qué le pasa al suprimir. Un test falla si aparece una tabla sin inventariar, así que no puede quedar viejo en silencio |

Las referencias a cláusulas ISO/ASVS son orientativas para ordenar el trabajo;
la numeración exacta se valida con el auditor cuando la certificación empiece
(Fase 6, #81).

## Cómo se lee el estado

- **hecho** — está construido y hay un test que lo sostiene. Lo puede verificar
  cualquiera leyendo el código.
- **hecho por proveedor** — lo resuelve la infraestructura contratada, no
  nuestro código. Se sostiene con el contrato del proveedor, no con un test.
- **parcial** — una parte está y la otra se nombra explícitamente. Nunca se
  deja en "hecho" algo a medias.
- **pendiente** — no está. Se dice, no se maquilla.
- **pendiente (legal)** — no lo resuelve el código; necesita una persona con
  título de abogado.

Ninguna fila dice "cumple ISO", y ninguna lo dirá: la arquitectura es
auditable, la certificación es un proceso aparte (SPEC §30).

## Lo que falta para responder a un cliente que pide contrato de tratamiento

1. El borrador de contrato revisado por abogado (fila propia, arriba).
2. Las cuatro filas de transferencia internacional con su contrato firmado.
3. El restore cronometrado (#80) y el ensayo de notificación de brechas.
4. MFA para quien administra (#7).

Las tres primeras no son código. La cuarta sí, y está identificada.
