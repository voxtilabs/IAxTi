# Arquitectura de IAxTi

Diagramas de referencia. La fuente de verdad es `docs/SPEC.md`; ante conflicto,
manda el SPEC. Cada decisión tiene su ADR en `docs/adr/`.

## 1. Infraestructura (etapa 1: un VPS)

```mermaid
flowchart TB
  subgraph internet[Internet]
    C[Cliente WhatsApp]
    U[Usuario del tenant<br/>navegador / celular]
    K[Zavu<br/>capa de canales<br/>WhatsApp · Instagram · Messenger]
    L[Landing comercial<br/>iaxti.cl · www<br/>Vercel — NO es la app]
    G[Google<br/>Calendar · Drive · Gmail]
    P[Pasarela de pago]
  end

  subgraph cf[Cloudflare]
    WAF[Proxy · WAF · rate limit<br/>/api/* y /webhooks/*]
    ACC[Access<br/>panel Dokploy · admin staging]
  end

  subgraph vps[VPS · Dokploy · misma región que Supabase]
    T[Traefik TLS]
    subgraph stg[iaxti-staging :staging]
      SW[web] ~~~ SA[admin] ~~~ SAPI[api] ~~~ SWK[workers] ~~~ SAG[agents]
      SR[(redis)]
    end
    subgraph prd[iaxti-prod :vX.Y.Z]
      PW[web] ~~~ PA[admin] ~~~ PAPI[api] ~~~ PWK[workers] ~~~ PAG[agents]
      PR[(redis)]
    end
  end

  subgraph ext[Servicios gestionados]
    SB[(Supabase<br/>Postgres+pgvector · Auth · Realtime · PITR)]
    R2[(Cloudflare R2<br/>adjuntos · backups)]
    GH[GHCR<br/>imágenes]
    LF[Langfuse]
    SEN[Sentry]
    GC[Grafana Cloud]
    GEM[Gemini<br/>Developer API]
  end

  C -->|mensajes| K -->|webhook firmado| WAF --> T
  U --> WAF
  T --> SAPI & PAPI
  SAPI & PAPI --> SB
  SWK & PWK --> SR & PR
  SAG & PAG --> GEM & LF
  SAPI --> R2
  GH -->|pull, nunca build en VPS| vps
  G <--> SAPI
  P -->|webhook| WAF
```

## 2. Sistema de módulos

```mermaid
flowchart TB
  subgraph core[packages/core — no conoce ningún módulo]
    REG[Module Registry<br/>lee module.yaml · grafo · orden topológico<br/>ciclos y colisiones abortan el arranque]
    CAP[capabilities.get&#40;id&#41;<br/>opcional: null degrada]
    BUS[Outbox transaccional<br/>consumidores idempotentes]
  end

  subgraph nucleo[Núcleo — nunca se apaga]
    ID[identity] --- ORG[organizations] --- AUTH[authorization] --- AUD[audit]
  end

  subgraph negocio[Módulos de negocio — interruptor por plataforma y por tenant]
    CRM[crm] --- CONV[conversations] --- CH[channels]
    WA[whatsapp] --- WC[webchat] --- AG[agents]
    KN[knowledge] --- AUTO[automations] --- CAL[calendar]
    PAY[payments] --- INT[integrations] --- AN[analytics]
    BIL[billing] --- NOT[notifications] --- PLAT[platform]
  end

  REG -->|inicializa en orden| nucleo --> negocio
  negocio -->|import solo vía contract.ts<br/>dependency-cruiser lo verifica en CI| negocio
  negocio -->|publica/consume por nombre| BUS
```

Módulo apagado para un tenant: endpoints responden `MODULE_DISABLED`, navegación
y widgets desaparecen (`GET /me/modules`), tools no se registran, jobs se saltan.
Los datos no se tocan.

## 3. Verificación de permisos (toda request, toda tool)

```mermaid
flowchart LR
  REQ[Request /v1<br/>JWT o API key] --> RID[X-Request-Id<br/>entra o se genera]
  RID --> M{"@RequireModule<br/>¿activo para el tenant?"}
  M -->|no| MD[403 MODULE_DISABLED]
  M -->|sí| PERM{"@RequirePermission<br/>rol → paquete de permisos"}
  PERM -->|no| DEN[403 + evento permission.denied]
  PERM -->|sí| TEN{tenant context<br/>SET app.tenant_id}
  TEN --> OBJ{¿dueño / equipo<br/>del objeto?}
  OBJ -->|no| DEN
  OBJ -->|sí| SVC[Caso de uso] --> RLS[(RLS en Postgres<br/>segunda cerradura)]
  SVC --> AUDIT[(audit_log<br/>misma transacción)]
```

Las tools de los agentes pasan por el mismo guard con la identidad del usuario
que conversa (`on_behalf_of`). Las API keys, con `actor_kind = apikey`.

## 4. Mensaje de WhatsApp de punta a punta

```mermaid
sequenceDiagram
  participant Cliente
  participant Zavu
  participant API as api /webhooks
  participant Q as cola inbound
  participant W as workers
  participant DB as Postgres
  participant AG as agents (copiloto)
  participant V as Vendedor (bandeja)

  Cliente->>Zavu: mensaje
  Zavu->>API: webhook (envelope Zavu, firmado t=,v2=)
  API->>API: verifica firma HMAC
  API->>Q: encola (idempotente por id de mensaje)
  API-->>Zavu: 200 en < 1 s
  Q->>W: procesa
  W->>DB: contacto (crea si no existe) + conversación + mensaje
  W->>DB: outbox: message.received
  DB-->>V: Realtime broadcast → bandeja
  W->>AG: si módulo agents activo
  AG->>AG: get_context (N mensajes + ficha) → Gemini
  AG->>DB: Suggestion + Execution (trace Langfuse)
  DB-->>V: sugerencia en aviso action-soft
  V->>API: "Enviar sugerencia" (o edita)
  API->>Q: cola outbound (ventana 24h · silencio · rate limit por número)
  Q->>Zavu: send
  Zavu->>Cliente: mensaje
  Zavu->>API: estados sent/delivered/read → bandeja
```

En modo autónomo (opt-in, por horario), el paso del vendedor lo hace el agente
dentro de las reglas de escalamiento; el mensaje queda marcado "respondió el
asistente".

## 5. Flujo del configurador

```mermaid
sequenceDiagram
  participant U as Dueño (onboarding)
  participant CFG as agents (configurador)
  participant API as api (rutas admin)
  participant DB as Postgres

  U->>CFG: cómo vende, qué pasa después, cómo cobra (máx 3 preguntas)
  CFG->>CFG: plantilla de la vertical + Gemini (modelo alto)
  CFG-->>U: diff "antes / después" (pipeline, campos, etiquetas,<br/>respuestas rápidas, 3 automatizaciones, 3 plantillas WA)
  U->>CFG: "Armar mi CRM"
  CFG->>API: mismas APIs de admin, permisos del usuario
  API->>DB: aplica + audit (user via agent)
  API-->>U: CRM armado; todo editable después
```

## 6. Flujo de un pago

```mermaid
sequenceDiagram
  participant V as Vendedor o IA
  participant API as api
  participant PP as Pasarela
  participant C as Cliente
  participant DB as Postgres

  V->>API: crear link (monto de la oportunidad; IA: tope + confirmación)
  API->>PP: crea link
  API->>C: link por la conversación (cola outbound)
  C->>PP: paga
  PP->>API: webhook (verificado, idempotente, encolado)
  API->>DB: Payment + link paid + audit
  API->>DB: mueve oportunidad a etapa de pagado (si configurado)
  DB-->>V: comprobante en la conversación + notificación
```

## 7. Ciclo de vida del tenant

```mermaid
stateDiagram-v2
  [*] --> trial: registro (14 días, módulos de Crece)
  trial --> active: elige plan y paga
  trial --> read_only: prueba vencida (30 días de gracia de datos)
  active --> past_due: impago (7 días de gracia con aviso)
  past_due --> active: paga
  past_due --> read_only: sigue impago
  read_only --> active: paga
  read_only --> suspended: 30 días
  suspended --> deleted: 90 días (exportación ofrecida antes)
  active --> read_only: cancela (exportación completa primero, al fin del ciclo pagado)
```

`read_only`: se reciben mensajes, no se envían salvo respuestas manuales. Bajar
de plan nunca borra: los módulos que sobran pasan a solo lectura.
