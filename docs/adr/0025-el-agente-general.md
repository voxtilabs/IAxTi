# ADR 0025 · El Agente General

**Estado:** aceptada · 2026-09-25 · decide el dueño del producto · se apoya en
la [ADR-0017](0017-que-puede-escribir-la-ia.md) y supersede parcialmente la
[ADR-0023](0023-proveedor-economico-glm.md)

## Contexto

Esta construcción encontró el mismo defecto treinta y una veces: **función
construida, sin puerta**. Diecinueve rutas sin pantalla en #460, doce más en
#480 — entre ellas obligaciones legales (los derechos del titular), trabajo
diario (editar un contacto) y configuración entera (embudos, horarios,
retención). Cada una se cerró construyendo un formulario, y cada formulario
es diseño, pruebas y mantención para siempre. La UI de configuración crece
linealmente con las funciones, y ese costo es el que nos estaba matando:
la API llegaba meses antes que su puerta.

Mientras tanto, tres piezas ya construidas apuntaban a otra salida sin que
las hubiéramos leído así:

- El endpoint **MCP** (#419) expone herramientas de la plataforma a una IA
  de afuera, **filtradas por permiso**: una key sin `crm.deals.create` ni
  siquiera ve esa herramienta en `tools/list`.
- El **configurador** (#50, #415) ya es un agente que entiende el negocio,
  **propone un diff y el humano aplica**.
- El modelo de datos ya soporta **varios agentes por tenant** (`/agents` es
  una lista); solo la UI asumía uno.

## Decisión

### 1 · Un Agente General, de plataforma

Existe **un** Agente General. No pertenece a ningún tenant: es el empleado
experto de IAxTi. Hace tres cosas:

1. **Crea y configura los agentes de cada cliente**, a medida. El cliente
   conversa; el Agente General decide cuántos agentes necesita ese negocio
   (vender, administrar, responder números), con qué herramientas, con qué
   objetivo medible (#319) y con qué tono. "Varios agentes por negocio"
   deja de ser una pantalla: es una decisión que el Agente General toma y
   explica.
2. **Es la vía de configuración universal.** Todo lo que la API sabe hacer
   se le puede pedir conversando. Una función nueva queda disponible el día
   que existe su ruta, sin esperar pantalla.
3. **Diagnostica.** Se le puede preguntar «¿qué me falta?» y responde con
   el estado real: el onboarding por módulo (`GET /onboarding` ya calcula
   cada paso contra lo que hay HOY), los huecos de configuración —horarios
   sin definir, plantillas sin aprobar, número sin conectar— y la salud del
   negocio.

### 2 · Lo simple sigue siendo un clic

Las pantallas ya construidas **se quedan**: la bandeja, el tablero, la
agenda y los ajustes existentes no se reemplazan por una conversación.
Regla nueva: **nada nuevo exige pantalla**. Una función nueva nace como
ruta + herramienta; gana pantalla solo si el uso diario lo pide. El guard
de #447/#480 cambia de «toda ruta tiene pantalla» a **«toda ruta tiene
herramienta o pantalla»** — y la lista de excepciones se muere.

### 3 · El catálogo de herramientas sale del OpenAPI

Las herramientas se **generan** del documento OpenAPI —la misma fuente de
la que ya sale el SDK (#348), así que no son una suposición— con una capa
curada encima: descripción en español pensada para el modelo, y la marca de
si la acción es reversible. Un guard comprueba que el catálogo cubre el
documento; una ruta nueva sin herramienta rompe CI.

Los permisos no cambian de lugar: el Agente General actúa **con la
identidad de quien le habla** y pasa por los mismos guards que una llamada
HTTP. Con el dueño puede todo lo que puede el dueño; con un vendedor, lo
que puede un vendedor. Los agentes de cliente reciben solo las
herramientas de su rol, como ya lo hace el copiloto.

### 4 · Lo irreversible se confirma

El patrón del configurador se vuelve ley para todos los agentes:

- **Leer y crear apagado**: libre.
- **Lo irreversible o lo que le llega a un cliente** (cancelar la
  suscripción, mandar una campaña, borrar, cambiar un rol): el agente arma
  el diff, lo muestra, y **una persona confirma**. Nunca «ya lo hice» sin
  ese paso.

Todo lo que el Agente General ejecuta queda en el **audit** con su cadena
de hash, con `actor_kind` propio: se distingue para siempre qué hizo una
persona, qué hizo un agente de cliente y qué hizo el Agente General.

### 5 · Visión 360 en el panel de SuperAdmin

El Agente General es la pieza más crítica del producto y vive a la vista:

- **Cada corrida**: tenant, qué pidió el cliente, qué herramientas usó, qué
  diff aplicó, costo, latencia, trace.
- **Kill-switch** global y por tenant: apagarlo deja al producto como hoy
  (pantallas + configurador), no a oscuras.
- **Prompt versionado con gate**: su prompt de sistema se cambia como se
  cambia el de los agentes de cliente — corre la evaluación (#53) y si
  rinde peor, no se promueve.
- **Tasa de error y fallback**: si el proveedor falla, cae al de respaldo y
  el panel lo muestra.

### 6 · Runtime: AI SDK de Vercel

El loop de tool-calling se ejecuta sobre el **AI SDK de Vercel**, que
estandariza herramientas, streaming y proveedores — GLM entra por su API
compatible con OpenAI. Lo que NO se reemplaza: los permisos, la cuota, el
costo por corrida, el audit y las evaluaciones siguen siendo nuestros. El
SDK ejecuta; las reglas las ponemos nosotros.

### 7 · El proveedor es GLM — decisión del dueño, con dos resguardos

El dueño del producto decide (2026-09-25) que **todo corre en GLM**: el
Agente General y los agentes de cliente. Esto **supersede la restricción
por tarea** de la ADR-0023 (`glm` solo `clasificar`, redactado).

La ADR-0023 no se equivocaba en los hechos y sus hechos siguen: Zhipu no
publica si entrena con la API, ni entidad ni jurisdicción; existe una «no
retención» opt-in desde el 20/09/2026 que no cubre Batch/File API. La
Ley 21.719 sigue aplicando a lo que viaje. Cambia la decisión de negocio,
y queda registrada acá con estos resguardos:

1. **La «no retención» se activa en nuestra cuenta antes de que un tenant
   real pase por GLM**, y los tres papeles (no-entrenamiento, plazo de
   retención, jurisdicción) se siguen persiguiendo; la matriz de
   compliance mantiene su fila en «parcial» hasta tenerlos.
2. **«Solo Gemini» por tenant se mantiene**: al cliente que lo pida se le
   da sin discusión, y es lo que se ofrece si un contrato de tratamiento
   lo exige.
3. **El gate de evaluación manda también aquí**: si GLM rinde peor en
   corrección, tono chileno o elección de herramienta, el fallback (Gemini)
   toma la tarea y el panel lo dice. Ahorrar con un modelo que configura
   mal un negocio es más caro que el margen.

### Actualización 2026-09-25 · la cuenta sirve GLM por NVIDIA

La llave entregada es del **catálogo de NVIDIA** (`nvapi-`,
`integrate.api.nvidia.com`), que sirve `z-ai/glm-5.3` y
`z-ai/glm-5.3-flash`. Eso cambia el cuadro de la §7 para mejor: **el
destino de los datos es NVIDIA (EE.UU.), no Zhipu directo**, y los
términos a verificar pasan a ser los de NVIDIA. Tool-calling y streaming
verificados ese mismo día contra el endpoint real. Queda pendiente
confirmar la tarifa por token de nuestra cuenta para el panel de costos
(mientras, referencia provisional de la familia GLM, corregible por
`AGENT_PRICES_JSON` sin deploy).

## Consecuencias

- El costo de una función nueva baja a: ruta + herramienta + prueba. La
  pantalla es opcional.
- El panel de SuperAdmin pasa de tabla de tenants a **centro de control**
  del Agente General.
- `SIN_CONSUMIDOR` desaparece como lista de pantallas pendientes; el guard
  nuevo exige herramienta o pantalla.
- La API key de GLM entra **por referencia** (`GLM_API_KEY`), jamás en git,
  y rota al cierre de la construcción como todas las pegadas en el chat.
