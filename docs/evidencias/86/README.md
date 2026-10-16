# #86 · Disponibilidad y costos documentados de llamadas

Consulta pública del **16-10-2026** para el criterio 2 de [#86](https://github.com/voxtilabs/IAxTi/issues/86), leído junto con su [comentario completo del 13-09](https://github.com/voxtilabs/IAxTi/issues/86#issuecomment-5655717883). Base del repositorio: `79936e77bfa57ebcfbcc16b81888af2fdb9983c7`.

Este registro completa la investigación documental accesible sin cuentas. **No acredita la disponibilidad de un número del proyecto ni cierra C2 o la issue.** No hubo llamadas, sandbox, contacto con proveedores, activaciones, compras ni cambios de producto. No decide arquitectura, proveedor, alcance v1 ni costos por tenant.

## Disponibilidad de Meta y habilitación por número

| Dato comprobado en documentación oficial | Alcance |
| --- | --- |
| Las llamadas entrantes están disponibles donde funciona Cloud API. Las salientes excluyen números **del negocio** de Estados Unidos, Canadá, Egipto, Vietnam y Nigeria; el destinatario puede estar donde Cloud API esté disponible. | [Meta · Calling, disponibilidad](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/). No confundir país del negocio con destino facturado. |
| Cloud API excluye Cuba, Irán, Corea del Norte, Siria y las regiones Crimea, Donetsk y Lugansk. | [Meta · restricciones por país](https://developers.facebook.com/documentation/business-messaging/whatsapp/support#country-restrictions). Chile no figura en estas exclusiones ni en las de llamadas salientes: **inferencia de disponibilidad geográfica**, no certificación de una cuenta. |
| En producción se requiere número Cloud API, permiso `whatsapp_business_messaging`, app suscrita a la cuenta y a `calls` salvo señalización SIP, límite de al menos 2.000 destinatarios diarios y llamadas habilitadas. | [Meta · requisitos](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/). Nada de esto se comprobó para un número de IAxTi. |
| Meta documenta números de prueba públicos y cuentas sandbox; estas últimas son para Tech Partners. Las pruebas indicadas exceptúan el umbral de 2.000; las llamadas de números de prueba vienen deshabilitadas. | [Meta · pruebas](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/). Es una capacidad de Meta; no implica que el sandbox de un intermediario la ofrezca. |
| Una llamada saliente necesita permiso del usuario, temporal o permanente; el usuario puede revocarlo. | [Meta · permisos](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-call-permissions/). La guía de [Kapso · salientes](https://docs.kapso.ai/docs/whatsapp/calling/outbound-calls) exige comprobar `start_call.can_perform_action`: entregar una solicitud o recibir llamadas no basta. |

El requisito de la issue sobre rollout por número queda documentado pero pendiente de observación real. La página [SDK Calls de Kapso](https://docs.kapso.ai/docs/whatsapp/typescript-sdk/calls) aún advierte habilitación gradual. No se deduce que un número pueda llamar porque su país sea admisible.

## Tarifa Meta hacia Chile

Se leyeron los CSV **USD y CLP con vigencia 01-10-2026**, enlazados en la sección de esa fecha de [Meta · precios de Calling](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/pricing/). La página conserva también hojas anteriores; no se usaron como tarifa vigente. Los siguientes valores son por minuto de llamada **iniciada por el negocio hacia un número chileno**:

| Minutos mensuales del tramo | USD/min | CLP/min |
| --- | ---: | ---: |
| Hasta 50.000 | 0,0121 | 10,6833 |
| 50.001–250.000 | 0,0098 | 8,6526 |
| 250.001–1.000.000 | 0,0086 | 7,5930 |
| 1.000.001–2.500.000 | 0,0074 | 6,5336 |
| 2.500.001–5.000.000 | 0,0066 | 5,8272 |
| Desde 5.000.001 | 0,0055 | 4,8561 |

Son dos hojas oficiales por divisa, **no una conversión calculada**. Meta cobra en pulsos de seis segundos redondeados hacia arriba; una llamada que cruza un tramo usa el precio del tramo de mayor volumen. Las llamadas iniciadas por el usuario no tienen cargo de Calling de Meta. Las solicitudes de permiso son mensajes con su propia tarifa; se exige método de pago válido. [Fuente de estas reglas](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/pricing/).

Para identificar los CSV consultados sin depender de URLs temporales del CDN:

- USD, encabezado de vigencia `October 1, 2026`; SHA-256 `046ab0e99ef1c258d80285bcf1ddb443a63e5ab1f27abed691cafb980d6256a9`.
- CLP, mismo encabezado; SHA-256 `6267153fbe8138a3addd25be4978cbf7bf2d6b84624f7d2bcb9734c34ca9981c`.

Estos importes no son un precio final de IAxTi. [Kapso · precios de llamadas](https://docs.kapso.ai/docs/whatsapp/pricing-faq) separa Meta del runtime de voz, alojamiento y modelos. [Zavu · Voice Agents](https://docs.zavu.dev/guides/voice-agents/overview) factura minutos conectados más telefonía; no publica allí una cifra específica por minuto a Chile. Esa cifra, la divisa efectiva de la cuenta y eventuales cargos del intermediario quedan sin verificar.

## Kapso y Zavu: contratos distintos

| Superficie oficial consultada | Qué acredita y qué no |
| --- | --- |
| [Kapso · Calling](https://docs.kapso.ai/docs/whatsapp/calling/overview) | Proxy de acciones de Meta y webhooks; el audio y el agente viven en el servidor o proveedor de voz del integrador. Su sandbox **no soporta Calling** y los números en coexistencia conservan las llamadas en WhatsApp Business App. Requiere número dedicado elegible, clave del proyecto, webhook HTTPS y servidor de medios. `calling.status = ENABLED` es una comprobación documentada, no ejecutada aquí. |
| [Kapso · SDK Calls](https://docs.kapso.ai/docs/whatsapp/typescript-sdk/calls) y [recepción](https://docs.kapso.ai/docs/whatsapp/calling/receive-calls) | Documentan `connect`, `preAccept`, `accept`, `reject`, `terminate` y consulta de permiso. El SDP sale de una sesión WebRTC real; `pre_accept` no equivale a contestar. La documentación actual describe eventos y estados de llamada: la carencia de detalle anotada en septiembre no debe repetirse como hecho actual. |
| [Zavu · guía de inicio](https://docs.zavu.dev/guides/voice-agents/quickstart) | Exige Voice Agents habilitado para el equipo, agente con voz, clave `zv_live_` y número asignado para recibir. No admite claves de prueba. La guía aún describe activación por el equipo de Zavu; no se comprobó esa habilitación en nuestra cuenta. |
| [Zavu · referencia de llamadas](https://docs.zavu.dev/api-reference/voice-agents/place-a-voice-call) y [OpenAPI](https://docs.zavu.dev/openapi.json) | `POST /v1/calls` hace una llamada telefónica con el pipeline gestionado del agente. La referencia documenta cupos diarios, revisión automática, saldo y errores; no documenta SDP ni selección de un canal WhatsApp. En los 131 paths del OpenAPI leído, las rutas de llamadas son `/v1/calls`, `/v1/calls/{callId}` y `/v1/calls/{callId}/hangup`. No se encontró un contrato público de señalización Calling de WhatsApp en esa superficie; eso **no demuestra inexistencia de una capacidad privada**. |
| [Zavu · webhooks de voz](https://docs.zavu.dev/guides/voice-agents/webhooks) | Publica `call.initiated`, `call.answered`, `call.completed` y `call.failed`, con firma `X-Zavu-Signature`. Estos eventos pertenecen a su voz telefónica; no acreditan un webhook de Calling de Meta ni un registro ya implementado en la conversación de IAxTi. |

La referencia Zavu de `POST /v1/calls` describe límites de acceso más recientes que la guía introductoria. No se resuelve esa diferencia afirmando que el proyecto ya tenga voz habilitada. Tampoco se inventa un endpoint WhatsApp a partir del endpoint telefónico. SHA-256 del OpenAPI consultado: `9e08a7b910f2a30e2b38ce568ac89f7ec7b37e72096c2f60c824648c9565d395`.

## Relación con el repositorio y aceptación pendiente

[SPEC §12](../../SPEC.md) y [ADR-0014](../../adr/0014-zavu-como-capa-de-canales.md) mantienen Zavu como transporte; no autorizan adoptar su agente gestionado. El [puerto de canales](../../../packages/modules/channels/domain/port.ts) de la base revisada cubre mensajes, firma, normalización y plantillas; esta documentación no le agrega llamadas.

| Criterio de #86 | Resultado de este tramo |
| --- | --- |
| C1 · entrante y saliente en sandbox | No probado. Se identificó la diferencia entre pruebas Meta y sandbox Kapso. |
| C2 · disponibilidad, requisitos y costo Chile | Fuentes públicas y tarifas verificadas; habilitación por número, exposición por Zavu y costo completo de la cuenta pendientes. |
| C3 · arquitectura | No evaluada ni decidida en este cambio. |
| C4 · llamadas registradas en conversación | No implementado ni probado. |
| C5 · ADR, fase, alcance v1 y costo por tenant | Decisión reservada; sin ADR nuevo. |

Método: lectura de documentación oficial y OpenAPI, descarga de CSV públicos, comparación de las seis filas de Chile y referencias locales. El extractor web devolvió 429 para Meta; la lectura HTTPS directa de las páginas públicas y de sus CSV devolvió 200. No se usaron blogs, precios de mensajería como precios de voz ni ejemplos `+56` como prueba de cobertura real. No se ejecutaron endpoints de llamadas ni pruebas de producto por este cambio documental.
