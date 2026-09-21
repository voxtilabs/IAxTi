# ADR 0023 · El proveedor económico (GLM) y qué le podemos mandar

**Estado:** aceptada · 2026-09-21 · decide el issue #54 · se apoya en la
[ADR-0006](0006-observabilidad.md) y la
[ADR-0017](0017-que-puede-escribir-la-ia.md)

## Contexto

Las sugerencias de respuesta son el mayor volumen de tokens del producto:
cada mensaje entrante de cada conversación de cada tenant. El runtime
soporta proveedor y modelo **por tarea** desde #47, así que cambiar solo las
tareas de alto volumen a un modelo más barato es configuración, no un
rediseño.

El candidato es **GLM, de Zhipu (Z.ai)**. El adaptador ya está en el código:
`provider: 'glm'` existe y se puede fijar por tarea sin desplegar.

Lo que faltaba no era técnico. Por acá pasan conversaciones de WhatsApp de
clientes de nuestros clientes: nombres, teléfonos, direcciones, a veces el
motivo de una consulta de salud. Eso es dato personal de personas chilenas y
le aplica la **Ley 21.719**. La pregunta que decide esta ADR no es "¿es más
barato?" —lo es— sino **qué le podemos mandar**.

## Lo que se encontró en sus términos

Revisado el 21/09/2026:

1. **No publican si entrenan con lo que entra por la API.** Su documentación
   pública —precios, guía de inicio, plan de coding— no responde si los
   prompts de la API alojada se usan para entrenar modelos futuros.
2. **No hay un opt-out de entrenamiento publicado** que cubra entradas y
   salidas de la API alojada.
3. **Sí hay, desde el 20/09/2026, un mecanismo de "no retención" opt-in**,
   anunciado para su plataforma MaaS: activado, no almacenan estáticamente
   entradas ni salidas, y los datos se usan solo para completar la llamada
   en curso. Con tres bordes explícitos: se pide (no viene puesto), **no
   cubre Batch API ni File API**, y pueden retener 30 días o más por
   obligación legal o por investigar abuso.
4. **No publican qué entidad contrata ni qué jurisdicción gobierna** el
   acuerdo.
5. El contexto importa: ese anuncio llegó después de que su herramienta de
   coding subiera al cloud, **con la opción activada por defecto**, el
   workspace y el historial de Git de sus usuarios. Lo corrigieron y
   pidieron disculpas. Lo que eso dice no es que sean deshonestos: dice cuál
   es su postura por defecto, y su postura por defecto es que los datos
   entran.

Contra eso, Gemini se usa hoy con su API de pago, donde el uso para
entrenamiento está excluido por términos publicados.

## Decisión

**GLM queda disponible como proveedor por tarea, y NO se enciende para
tareas que llevan datos de clientes hasta tener tres cosas por escrito para
NUESTRA cuenta:**

1. que no se entrena con lo que mandamos;
2. la "no retención" activada, con su período en días para lo que sí
   retengan por ley o abuso;
3. qué entidad contrata y qué jurisdicción gobierna.

Sin las tres, GLM puede usarse **solo** en `clasificar`, y con el prompt
redactado antes de salir.

Acá hay una corrección importante sobre lo que creíamos tener. `redactPII`
existe desde hace rato, pero protege a **Langfuse y al dataset de
evaluación**, no al proveedor: al modelo el texto iba entero. Y tiene que ir
entero — redactar lo que se le pide interpretar rompe la sugerencia. La
matriz de compliance ya lo decía en su fila «Contenido del cliente hacia el
proveedor LLM», y es fácil leer "redacción de PII" y creer que cubre algo
que no cubre.

`clasificar` es la excepción, y por eso es la única tarea que entra:
**etiquetar no es interpretar**. Saber si un mensaje es una consulta de
precio o un reclamo no necesita el teléfono ni el nombre de quien escribe.
Es además una tarea de alto volumen, así que sirve de verdad para medir.

Esto queda **aplicado en el código**, no solo escrito acá:

- `proveedorPermitidoParaTarea` decide qué tareas acepta un proveedor sin
  garantías; la configuración del tenant que no se acepta **cae al por
  defecto** en vez de fallar, porque un mensaje de un cliente esperando
  respuesta no es el lugar para enseñar una política. El modelo cae con el
  proveedor: `glm-4.6` apuntando a Google sería un 404 en cada mensaje.
- `vaRedactadoAlProveedor` redacta el prompt antes de mandarlo, y solo en
  ese caso.
- Un proveedor sin garantías **no puede ser el modelo económico** (#52): el
  económico se usa para cualquier tarea cuando la cuota llega al 100 %, así
  que sería la puerta de atrás para que `sugerir` termine ahí justo el día
  de más volumen.

Dos condiciones más, que valen incluso con las tres cosas por escrito:

- **La opción por tenant "solo Gemini" queda disponible**, y es la que se le
  ofrece a cualquier cliente que lo pida sin tener que explicarle por qué.
- **El dataset de evaluación (#53) manda.** Si GLM rinde peor en corrección,
  en tono chileno o eligiendo herramienta, no entra: ahorrar en un modelo
  que contesta peor es gastar en otra parte.

## Por qué no simplemente "sí, es más barato"

Porque el ahorro es nuestro y el riesgo es del cliente. Una peluquería de
Ñuñoa no eligió a Zhipu ni sabe quién es; nos eligió a nosotros. Si los
mensajes de sus clientas terminan entrenando un modelo, el que respondió mal
fuimos nosotros, y la Ley 21.719 no pregunta quién procesó.

Y porque el costo de equivocarse es asimétrico. Si nos quedamos en Gemini de
más, perdemos margen: es plata, se recupera. Si mandamos conversaciones a un
proveedor cuyos términos no dicen qué hace con ellas, no hay vuelta atrás —
lo que se fue, se fue.

## Consecuencias

- El costo variable por tenant baja menos de lo que podría hasta tener esos
  papeles. Es un costo conocido y aceptado.
- Queda una tarea (`clasificar`) donde probar el proveedor de verdad: alto
  volumen y redactable. Sirve para medir calidad, latencia y ahorro antes de
  decidir nada más grande.
- La matriz de compliance suma una fila con estos tres requisitos y con la
  fecha en que se revisaron los términos. Si el 20/09 cambió algo, puede
  volver a cambiar: esta ADR tiene fecha a propósito.
- El costo por modelo se ve en la cuota (#52), así que si GLM se enciende
  para `clasificar` el ahorro se puede medir y no estimar.

## Referencias

- Issue #54 · Prompt maestro §25, §30, §40
- [Zhipu open-sources ZCode after data dispute and plans no-retention controls for MaaS — TechNode, 21/09/2026](https://technode.com/2026/09/21/zhipu-open-sources-zcode-after-data-dispute-and-plans-no-retention-controls-for-maas/)
- [Zhipu AI MaaS platform launches "no data retention" — Futunn, 20/09/2026](https://news.futunn.com/en/post/79539588/zhipu-ai-02513-hk-open-sources-zcode-maas-platform-launches)
- [Z.AI Review: A Cheap API With Unpublished Data Terms — Layer3Labs, 02/09/2026](https://www.layer3labs.io/guides/z-ai-review)
