# #864 — puerto de audio y selección efectiva

Referencia: https://github.com/voxtilabs/IAxTi/issues/864. Cuerpo completo leído; sin comentarios al corte de trabajo. También se leyó #863 y la enmienda de ADR-0025. Rama `feat/864-audio-transcription`, base `79936e77bfa57ebcfbcc16b81888af2fdb9983c7`.

## Trazabilidad literal

| Criterio original | Implementación / evidencia | Estado |
|---|---|---|
| El puerto del modelo sabe transcribir por una API de audio, no solo por `/chat/completions`. | `models.ts`: SDK OpenAI `.transcription().doGenerate()` → multipart `/audio/transcriptions`. `audio-port.test.ts` inspecciona petición real del SDK con bytes/MIME/modelo y errores HTTP. | Implementado; HTTP interceptado, no API externa |
| `SOLO_TEXTO` deja de ser la forma de expresar esto: declarar qué proveedor sabe transcribir. | `config.ts`: capacidades positivas de los cuatro puertos; OpenAI/Google audio, GLM/Anthropic texto. Se prueban las nueve tareas y 16 combinaciones de credenciales. | Implementado |
| `transcribir` puede ir al mismo proveedor que el resto; si no puede, diagnóstico por capacidad. | Semilla OpenAI con modelo audio propio, configuración efectiva del tenant/plataforma, respaldo y `soloProveedor`; worker sin condición fija Google. Diagnóstico muestra capacidad/modelo efectivo y prueba de texto no promete haber transcrito. | Implementado y probado localmente |
| Fila Google en `COMPLIANCE_BASELINE.md` decidida, no solo anotada. | Solo se actualizan hechos técnicos; revisión contractual/decisión de Google sigue pendiente. El código no decide términos, retención ni jurisdicción. | **Pendiente de decisión externa; no completado** |
| Prueba con audio de verdad contra API de audio del proveedor por defecto. | Las pruebas usan silencio PCM sintético o bytes OGG de contrato y respuestas HTTP ficticias. No se cargaron credenciales ni se llamó a un proveedor. | **Pendiente de prueba real; no completado** |

## Flujo y límites

1. El worker resuelve el adjunto persistido por tenant + conversación + mensaje entrante de audio + key exacta. Comprueba prefijo del tenant antes de firmar; el MIME del job no manda. Descarga con reloj de 60 s y límite de 16 MiB, incluso sin `Content-Length`.
2. El caso de uso verifica/bloquea el mensaje del tenant, resuelve configuración efectiva y comprueba cuota antes de enviar. Una transcripción ya confirmada se reutiliza. No se garantiza evitar un segundo cargo si la llamada externa termina y luego la transacción revierte.
3. OpenAI recibe archivo multipart, nunca un file part de chat/Responses. Google conserva su API multimodal. No hay reintento automático pagado. El puerto valida formato/tamaño/modelo antes de llamar y aplica el timeout de IA existente.
4. Respuesta útil: mensaje buscable + Execution + auditoría + medidor + evento en la misma transacción. Si falla persistencia/auditoría se revierte todo lo local. Respuesta sin texto o truncada: conserva audio, registra fallo y consumo reportado; no anuncia éxito.
5. Solo números/metadatos mínimos salen a Execution/audit/eventos. El texto transcrito queda en el mensaje; audio y respuesta cruda no se añaden a trazas ni errores. No existe redacción automática de voz antes del proveedor.

El precio de transcripción se calcula solo con usage reportado y tarifa específica conocida; ausencia de uso o tarifa devuelve `null`, nunca costo cero inventado. No se usa tarifa de chat para Google audio. No hay nueva migración, dependencia, permiso ni endpoint. Se conserva la guarda de módulo en el consumidor de la cola.

## Fuentes oficiales y SDK

Consultadas el 16-10-2026:

- [API Transcriptions](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create): multipart, formatos (incluido OGG), JSON y esquema usage por tokens/duración.
- [Speech to text](https://developers.openai.com/api/docs/guides/speech-to-text): máximo 25 MB del proveedor; el producto mantiene 16 MiB. `timestamp_granularities` solo sirve para Whisper; el puerto evita el valor automático que el SDK añadía a mini-transcribe.
- [Precios](https://developers.openai.com/api/docs/pricing): tabla «Transcription models»; mini-transcribe entrada USD 1,25 / salida USD 5 por millón, transcribe 2,50/10; Whisper USD 0,006/min. Son estimaciones, no facturas de la cuenta.
- [Audio de Gemini](https://ai.google.dev/gemini-api/docs/generate-content/audio): formatos del puerto multimodal existente.
- SDK local comprobado: `@ai-sdk/openai` 4.0.91, `ai` 7.0.137. Se usa `doGenerate` porque conserva `usage` y MIME; el helper genérico instalado descarta `usage`. No se añadió dependencia.

## Verificaciones

Preflight completo `TODO=1 pnpm antes-de-empujar` terminado en verde: **2.928 tests aprobados + 14 omisiones existentes**, 28 paquetes de tests, tipos 54/54 tareas y build 30/30. Pasaron lint (4 advertencias previas), dependency-cruiser, guardas DB/core, catálogo, migraciones en base virgen y todos los escáneres; ningún baseline cambió.

La primera corrida señaló una expectativa heredada que decía que solo Google transcribía. Se corrigió conservando su invariante: con OpenAI ausente, el respaldo omite GLM por incapacidad y selecciona Google. La segunda corrida completa pasó sobre el código final.

**43 pruebas nuevas**: 26 del puerto/capacidades, 11 del pipeline con Postgres y 6 del worker. La crítica independiente de raíz (mismo contexto, autor distinto) repitió **43/43** en otra base de prueba y no dejó hallazgos bloqueantes. No se presenta como contexto limpio.

Evidencias dirigidas: puerto HTTP, pipeline con Postgres real, RLS entre tenants, rollback por auditoría, cuota previa, concurrencia/reentrega confirmada, worker con Google ausente y adjuntos sustituidos. Fixtures ficticios; ningún envío real ni coste externo.

El script existente de evals se ejecutó sin credenciales: informa que se omite. Su dataset es de sugerencias de texto; no es una evaluación de transcripción ni un score aprobado de audio. El gate real y C5 permanecen pendientes.

`module-check`: cruces por contrato (nuevo lector de adjunto en conversations), eventos existentes y guarda de módulo del worker. `security-review`: pertenencia del adjunto antes de acceso, selección de proveedor explícita, RLS y rastro atómico, errores traducidos sin payload; filas técnicas actualizadas sin decisión legal. `rule-check`: cuota/consumo y ausencia de nuevos envíos, compromisos o herramientas. `ui-check`: no se modifica JSX/CSS; el diagnóstico utiliza sus componentes existentes. Crítica independiente de raíz: se incorporó el hallazgo de origen de audio previo a la firma.

No se declara #864 completa, cerrada, fusionada ni desplegada.
