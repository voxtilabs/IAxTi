# Conectar una IA de afuera a IAxTi (MCP)

IAxTi habla **MCP** en `POST /v1/mcp`. Sirve para que una IA que el negocio
ya use —Claude, ChatGPT, la que sea— pueda trabajar sobre su propio CRM:
consultar el contexto de una conversación, buscar en el conocimiento, leer
los números, y crear una actividad o una oportunidad.

## Qué se necesita

Una **API key del tenant** con el scope `agents.use`, más los scopes de lo
que quieras que pueda hacer. Se crea en Ajustes → API, y el token se ve una
sola vez.

`agents.use` es el interruptor: una key sin ese scope recibe 403 en `/mcp`
aunque tenga todos los demás. Es a propósito — la key que un ERP usa para
leer contactos no tiene por qué poder manejar el asistente.

## Cómo se conecta

```json
{
  "mcpServers": {
    "iaxti": {
      "url": "https://api.iaxti.cl/v1/mcp",
      "headers": { "Authorization": "Bearer iaxti_…" }
    }
  }
}
```

También se acepta `X-Api-Key`, que es como entra el resto de la API. El
`Bearer` está porque los clientes MCP no siempre dejan poner un header
propio.

## Qué va a ver del otro lado

`tools/list` devuelve **solo** las herramientas que esa key puede ejecutar:
las que declara un módulo ACTIVO de la cuenta y cuyo permiso la key tiene.
Una key sin `analytics.read` no ve `analytics.metrica`; no es que falle al
llamarla, es que no está. Ofrecer algo que va a fallar es peor que no
ofrecerlo, porque el modelo del otro lado lo intenta igual y se lleva un
error que no entiende.

Las que escriben son **dos**: `crm.create_activity` y `crm.create_deal`
(ADR-0017). Las otras —responder al cliente, agendar, mandar un link de
pago— no están y no van a estar por esta puerta: salen hacia el cliente o
pisan trabajo de una persona.

`calendar.get_slots` tampoco está: los horarios libres son los de UNA
persona, y una API key no es nadie de la agenda. Entra cuando el esquema
acepte de quién.

## Qué queda registrado

Cada llamada deja una línea en el libro de auditoría, con la key como actor
(`apikey:<id>`), el nombre de la herramienta y si salió bien. Se ve en
Ajustes → Auditoría igual que cualquier otra acción.

La cuota y el límite de velocidad por key son los mismos del resto de la
API: el MCP no tiene un carril aparte.

## Cuando algo no funciona

| Lo que ves | Qué pasa |
|---|---|
| `401 API_KEY_INVALID` | La key no existe, venció o fue revocada. |
| `403` al conectar | Le falta el scope `agents.use`. |
| `isError` con "no está disponible" | El módulo está apagado en esa cuenta, o falta ese scope. |
| `-32601` | El método no existe. Hoy hay `initialize`, `ping`, `tools/list` y `tools/call`. |

Un fallo de una herramienta **no** es un error de protocolo: vuelve como
`isError` con el motivo escrito, para que la IA del otro lado pueda leerlo y
seguir la conversación en vez de cortar la sesión.
