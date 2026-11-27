# #1389 · El Agente General propone en vez de preguntar todo

Medido el 26-11 en local, por el puerto del producto (`POST /v1/agente-general`,
la misma ruta que usa la web), con el proveedor configurado del despliegue
local (OpenAI). Dataset: `packages/modules/agents/evals/dataset-agente-general.json`
(5 mensajes de una dueña de pyme) × 3 vueltas. Script reproducible:
`scripts/medir-agente-general.mjs`.

Criterio por respuesta: **propone** el asistente (queda una propuesta esperando
visto bueno) **o** hace ≤ 2 preguntas en ≤ 60 palabras; y nunca nombra
herramientas, rutas ni permisos.

| | Antes | Después |
|---|---|---|
| Pasan | **0 / 15** | **15 / 15** |
| Proponen el asistente | 0 / 15 | 12 / 15 (los 3 que no: «Quiero un asistente para mi negocio», sin rubro — pregunta 1–2 cosas en ~30 palabras) |
| Mediana de palabras | 158 | 67 |
| Máximo de preguntas en una respuesta | 12 | 2 |
| Nombra herramientas («tool», `knowledge.`…) | sí (ferretería) | 0 |

Respuestas completas: `antes.json` y `despues.json`.

## La causa

Dos frases de la instrucción:

- «Antes de crear uno, **pide la lista de objetivos**» quería decir «consulta la
  lista de objetivos disponibles». El modelo se la pedía a la dueña: «necesito
  la lista exacta de objetivos que quieres cubrir».
- «**Pregunta lo que necesitas** para que quede a medida —a qué se dedica, cómo
  le hablan, qué quiere lograr—» se leía como «pregunta todo»: precios,
  duraciones, tono, horarios, en listas numeradas con ejemplos.

## Lo que se revisó a mano, además del criterio

- **No inventa precios ni stock.** Cuando no los tiene: «si falta un precio en
  el sistema, no lo inventa y lo deja para que ustedes confirmen»; «después
  cargamos tus precios exactos en el conocimiento del negocio».
- **Dice lo que asume:** «Asumo tuteo; lo cambias cuando quieras».
- **No da por hecho lo que no hizo:** «quedó esperando tu visto bueno».
- Una vuelta propuso **sin texto** (solo la tarjeta de la propuesta). En
  pantalla se entiende —la tarjeta dice «Necesito tu visto bueno»—, pero queda
  anotado.

## Lo que NO cubre

- Los datasets `sugerir` y `autonomo` (#53) miden a los asistentes que hablan
  con clientes, no al Agente General: este cambio no toca sus prompts. Su gate
  sigue sin correr en CI por el secreto de #1044.
- Si en Langfuse existe una versión publicada de `iaxti/agente-general`, esa
  manda sobre la del código (`getVersionedPrompt`): habría que publicar ahí la
  misma instrucción.
