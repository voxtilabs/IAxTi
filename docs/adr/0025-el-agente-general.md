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

### Actualización 2026-09-26 · «full GLM» y sus dos límites reales

Decisión del dueño: **todo en GLM, olvidarse de Gemini**. Aplicado donde se
puede, y medido donde no:

- **Texto: 100 % GLM.** Las ocho tareas de texto corren en `z-ai/glm-5.3` y
  `z-ai/glm-5.3-flash`, incluida la del Agente General.
- **Transcripción: no hay sustituto.** El catálogo de NVIDIA que sirve GLM
  **no publica ningún modelo de audio** (revisado el 25-09: cero ASR entre
  sus 82 modelos). Forzarla a GLM haría fallar cada nota de voz. Sin llave de
  Google la transcripción devuelve `null` y la nota de voz **llega igual, sin
  texto buscable**: es una degradación aceptada, no una falla. Queda como la
  única tarea con Gemini, y por capacidad, no por preferencia.
- **Embeddings del conocimiento: movidos (#502).** Corren en
  `nvidia/nemotron-3-embed-1b`, **2048 dimensiones fijas** — pedir
  `dimensions: 1024` responde «dimensions must be one of 2048». Tres cosas
  que costaron una migración y no un cambio de configuración:
  - De los siete modelos de embedding que lista el catálogo, **seis responden
    404 para esta cuenta** («Not found for account»). Solo ése está
    habilitado, así que no hay plan B dentro del mismo proveedor.
  - 2048 no entra en el índice HNSW de pgvector, que acepta **hasta 2000
    dimensiones** sobre `vector`. La columna pasó a `halfvec`, que se indexa
    hasta 4000: media precisión, la mitad de disco, y para ordenar por coseno
    la diferencia no se nota.
  - El modelo es **asimétrico**: le entra `input_type` y devuelve vectores
    distintos para el mismo texto según el rol (coseno 0.57 entre `query` y
    `passage` de «hola»). Con el rol correcto una pregunta le saca 0.430 al
    pasaje bueno contra 0.088 al malo; con el rol errado los puntajes se
    aplastan a 0.414 contra 0.385 y el orden lo decide el azar. Por eso
    `EmbedPort.embed` pide el rol como parámetro obligatorio: el compilador
    no deja olvidarlo, porque olvidarlo no falla — contesta peor y calla.
  El AI SDK no sirve acá: su proveedor compatible-OpenAI no manda
  `input_type`.

Y una corrección que este cambio dejó a la vista: el «solo este proveedor»
por tenant era configuración **tarea por tarea**, así que al agregar
`configuracion_conversada` un negocio que había pedido solo Gemini pasaba a
GLM en esa tarea sin que nadie cambiara nada. Ahora es un ajuste propio
(`ia.soloProveedor`) que cubre las tareas que existen y las que se agreguen:
un cliente que pide un proveedor por escrito no puede depender de que
alguien se acuerde de ampliarle una lista en el próximo despliegue.

### Enmienda 2026-10-12 · el proveedor pasa a OpenAI

Decisión del dueño, en sus palabras: **«lo único que quiero es OpenAI, que
tengo saldo»**. Se aplica a las ocho tareas de texto: `gpt-5-mini` para el
volumen, `gpt-5` para las pesadas. GLM queda elegible y como primer respaldo.

No es un cambio de gusto. Lo que lo sostiene, medido el mismo día contra las
dos cuentas con los mismos prompts:

| tarea | GLM (NVIDIA) | OpenAI |
|---|---|---|
| clasificar | 1,5 s | 2,6 s |
| resumir | 16,4 s | — |
| sugerir | **32,3 s** | **4,3 s** |
| configurar / agente general | **54,9 s** | **3,0 s** |

`sugerir` a 32 s no es lento, es inservible: #688 le puso un reloj de 60 s con
el argumento de que «si tarda más de un minuto ya no sirve porque la persona
contestó a mano», y a la mitad del reloj el argumento vale igual. El tope no
salta, así que nada avisa, y la bandeja simplemente no se usa. El 90 % del
presupuesto de salida de GLM se iba en razonar.

Y la razón que decide: la cuenta de NVIDIA no tiene saldo sostenido y la de
OpenAI sí. El 11-10 el producto quedó sin IA para todos los tenants porque el
único proveedor con llave en el contenedor estaba sin crédito. Un proveedor
por defecto sin plata detrás es el defecto esperando ocurrir.

Los dos resguardos de §7 siguen en pie y ahora apuntan a OpenAI: el contrato
—no-entrenamiento, plazo de retención, jurisdicción— sigue **sin revisar**, y
ahora pesa más que cuando era opcional, porque hoy el texto de las
conversaciones de todos los negocios sale hacia allá por defecto. Y el gate de
evaluación manda igual.

Lo que esta enmienda NO cambia:

- **`transcribir` sigue en Google** por capacidad, no por política: el audio
  entra como file part y el puerto habla `/chat/completions`. OpenAI sí
  transcribe, por otra API que el puerto todavía no habla (#864). O sea: los
  audios salen hacia un proveedor distinto que el texto, y esa es una fila
  propia de compliance.
- **El «solo este proveedor» por tenant** sigue existiendo tal cual. Lo que el
  dueño descartó —y queda escrito acá para no volver a proponerlo— es que la
  plataforma elija un modelo por defecto **distinto para cada tenant**: «no
  tiene sentido». El defecto es uno, de la plataforma.

### Enmienda 2026-10-12 (b) · cuánto piensa cada tarea

El dueño: «ahora responde, pero muy lento». Medido contra la cuenta el mismo
día, con los prompts reales:

| tarea | antes | con el dial | |
|---|---|---|---|
| `sugerir` (`gpt-5-mini`) | 7375 ms | **3830 ms** | `bajo` |
| `clasificar` | 6480 ms (5 casos) | **4918 ms** | `minimo`, 5/5 en los tres niveles |
| Agente General (`gpt-5`) | 4715 ms/llamada, 10/12 acertó | **1112 ms/llamada, 12/12** | `minimo` |

El 90 % del presupuesto de salida se iba en razonar, y eso se cobra como
salida: el dial es latencia **y** factura.

**Esto contradice un argumento de §7**, y conviene dejarlo escrito porque el
argumento sigue siendo bueno: «el Agente General usa el modelo que más razona
porque elegir mal una herramienta entre 195 es peor que responder lento». El
principio es correcto; la premisa —más razonamiento, mejor elección— es falsa
acá y está medida con doce casos reales. En mínimo acertó más y nunca pidió una
herramienta inventada ni se salteó la búsqueda cuando tocaba.

Lo que NO se hizo, con su motivo:

- **No hay orquestador maestro.** El dueño lo propuso —un modelo barato que
  clasifica y despacha—, y agregaría un viaje antes del que ya se hace. El
  ruteo por tarea ya existe: `DEFAULT_TASK_MODELS` son nueve rutas. Lo que
  faltaba era el tercer dial de cada una, no un despachador.
- **No se mapea a GLM.** NVIDIA acepta `reasoning_effort` sin error y no lo
  honra: medido, con `low` razonó MÁS (99 tokens contra 45). Un dial que se
  manda y se ignora es peor que no tenerlo.
- **No se mapea a Google ni Anthropic todavía.** Tienen equivalente, en tokens
  y no en niveles, y no hay cuenta con saldo para medirlos. En Anthropic
  además habilitar `thinking` donde está apagado es un cambio de
  comportamiento, no una calibración.
- **El dial NO es configurable por el negocio.** Cuánto piensa un modelo es de
  la misma familia que con qué modelo piensa, y eso el dueño ya lo decidió: el
  defecto es uno y de la plataforma (#858, «que yo pueda elegir el modelo
  default de cada tenant no tiene sentido»).
- **El streaming no era la solución**, aunque #859 lo recomendaba. Con un
  modelo que razona la primera palabra llega a los 4157 ms de 4594 totales,
  porque razona antes de escribir: el streaming compra 437 ms, el dial 2,5 s.

Y el dataset de regresión (#53), que por regla debería decidir estos valores,
**tiene cero casos** — salen del feedback humano sobre sugerencias, y como la
IA nunca funcionó nadie calificó ninguna. Por eso los valores salen de
mediciones a mano, declaradas en el código caso por caso, y se revisan cuando
el dataset pueda correr.

## Consecuencias

- El costo de una función nueva baja a: ruta + herramienta + prueba. La
  pantalla es opcional.
- El panel de SuperAdmin pasa de tabla de tenants a **centro de control**
  del Agente General.
- `SIN_CONSUMIDOR` desaparece como lista de pantallas pendientes; el guard
  nuevo exige herramienta o pantalla.
- La API key de GLM entra **por referencia** (`GLM_API_KEY`), jamás en git,
  y rota al cierre de la construcción como todas las pegadas en el chat.


### Implementación técnica de la capacidad de audio — #864 (16-10-2026)

La excepción de capacidad descrita el 12-10 arriba corresponde al puerto anterior.
El puerto incorpora `/audio/transcriptions` de OpenAI mediante el SDK instalado;
la semilla de `transcribir` pasa a `openai/gpt-4o-mini-transcribe`, con modelo
separado de chat. No sobrescribe filas de plataforma ni selecciones explícitas.
Google conserva su puerto multimodal y las reglas de respaldo/`soloProveedor`.
El diagnóstico declara capacidad, credencial y proveedor efectivo, sin afirmar
que una credencial o una petición de texto haya probado la transcripción.

La cuota se comprueba antes del acceso; una respuesta registra uso reportado,
costo estimado cuando hay tarifa conocida, Execution y auditoría en la misma
transacción. No se redacta la voz antes de transcribir: audio/transcripción no
se añaden a trazas, errores ni metadatos del rastro. La transcripción permanece
en el mensaje del tenant, como antes, para búsqueda/contexto.

Esto implementa C1–C3, no decide los términos de Google/OpenAI (C4) ni acredita
calidad de audio real o el gate de evaluación externa (C5). La evidencia local
usa HTTP interceptado y silencio PCM sintético; no se llamó a proveedores.
