# El conocimiento del agente de VoxTi Labs

Lo que el bot de WhatsApp sabe sobre VoxTi Labs, en archivos, **para que se
pueda leer sin entrar a la base de staging**.

Hasta ahora esto vivía solo en `knowledge_sources` del tenant
`ee3f97ae-43d0-4843-93ed-2d297fa7fd53`. El costo apareció el 08-11: para
cambiar lo que el bot decía había que entrar a staging primero, y desde fuera
nadie podía revisar qué estaba afirmando sobre la empresa.

## Cómo se escriben estos archivos

**Apuntes, no prosa terminada.** El modelo copia literal lo que parece
redactado, y `esEcoDelContexto` (#1021) lo detecta y escala: el acta queda con
`escalar: false` y una respuesta buena, pero el cliente recibe una derivación.
Por eso cada archivo abre con «NO copies estas líneas» y va en viñetas cortas.

**Una política se afirma como dato, nunca como ausencia.** «No hay lista de
precios publicada» hace que el modelo escale con `fuera_de_conocimiento` en la
pregunta que más se hace. Hay que decirle, con su propio vocabulario, qué
contestar y que NO escale.

**Lo que no sabemos también lleva su apunte.** Sin eso, «¿cuántos clientes
tienen?» deriva la conversación.

**El tema va en la PRIMERA línea, con las palabras que usa la gente.** Esto se
midió, no se supuso. La primera versión abría los cinco archivos con la misma
frase —«NO copies estas líneas…»— y cada archivo era un solo bloque mezclando
temas. Resultado: todas las notas se parecían entre sí y la recuperación daba
la nota EQUIVOCADA con puntajes de 0,09 a 0,24. «Qué hacen ustedes» traía la
de límites; «están en el stand» no traía nada.

Con el tema adelante y un archivo por pregunta, las seis preguntas de prueba
pegan en la nota correcta:

| Pregunta | Antes | Ahora |
|---|---|---|
| cuánto cuesta | 0,23 · equivocada | **0,27 · precios** |
| qué hacen ustedes | 0,17 · equivocada | **0,15 · servicios** |
| tienen clientes | 0,17 · equivocada | **0,24 · clientes** |
| están en el stand del evento | 0,09 · equivocada | **0,38 · el evento ya pasó** |
| quiero agendar una reunión | — | **0,54 · la reunión** |
| tienen un bot para whatsapp | — | **0,42 · productos** |

Se mide con `GET /v1/knowledge/search?q=…`, que es «qué encontraría la IA».
Antes de dar por bueno un cambio acá, correr esas preguntas.

## De dónde sale lo que dice

De `voxtilabs/Web_Voxti_labs_spa`, archivos `PRODUCT.md` y
`docs/product-platform.md`: son el contenido que el propio dueño confirmó para
el sitio, con sus límites editoriales ya decididos. **No se scrapeó el sitio**:
voxtilabs.cl está detrás del checkpoint de Vercel y devuelve 429 a curl y a
cualquier fetch; además el repo tiene el texto completo y sin renderizar.

## Al cargarlas

Una fuente recién cargada nace `processing` y tarda ~5 min en indexarse
(`knowledge.reindex` corre cada 5 min). Probar antes mide la ausencia del
conocimiento, no el cambio.
