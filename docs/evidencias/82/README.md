# #82 · Requisitos públicos vigentes para operar ante Meta

**Consulta:** 16 de octubre de 2026. **Alcance:** investigación documental del
criterio 1 de [#82](https://github.com/voxtilabs/IAxTi/issues/82), incluido su
[comentario del 13 de septiembre](https://github.com/voxtilabs/IAxTi/issues/82#issuecomment-5655705527).
Se consultaron las fuentes primarias de Meta indicadas abajo mediante HTTP
público, sin iniciar sesión. [fuentes.json](fuentes.json) registra URL, fecha,
respuesta y SHA-256 del contenido consultado. No acredita aprobación de una app,
verificación de IAxTi, acceso a cuentas de clientes ni una migración ejecutada.

## Verificación de negocio, revisión y designación

| Requisito | Qué exige la documentación consultada | Evidencia que faltaría obtener de la cuenta real |
| --- | --- | --- |
| Negocio verificado | Para permisos avanzados y datos de otros negocios, la app debe estar vinculada a un negocio verificado. Un administrador de la app puede vincularlo; la verificación la completa un administrador del negocio. La excepción para usuarios con rol en la app permite pruebas propias, no demuestra acceso para clientes externos. | Negocio y app vinculados; estado de verificación y rol del operador. |
| App Review | Meta debe poder acceder a la app y probar cada función que solicita permisos. La aprobación habilita el uso externo del permiso; el uso limitado a roles de la app no equivale a esa aprobación. | Solicitud presentada, revisión resuelta y acceso avanzado de cada permiso necesario. |

Fuentes: [Business Verification](https://developers.facebook.com/documentation/development/release/business-verification)
y [App Review](https://developers.facebook.com/documentation/resp-plat-initiatives/individual-processes/app-review).

**Cambio vigente relevante:** Meta anunció el **9 de octubre de 2026** la retirada
de la revisión separada *Access Verification*: elimina su formulario y la
comprobación de ese estado en las API. La clasificación *Tech Provider* se obtiene
por una actualización explícita de la app o por los permisos avanzados que pide;
*Direct Integrator* pasa a ser la clasificación predeterminada. Se mantienen
Business Verification, App Review y las obligaciones de tratamiento de datos
aplicables. No hay que añadir un tercer trámite retirado al inventario de pasos.
Fuente: [anuncio de Meta](https://developers.facebook.com/blog/post/2026/10/09/retiring-access-verification-for-tech-provider-apps/).

## WhatsApp: Tech Provider para otros negocios

La guía actual parte de una app Meta con el caso de uso WhatsApp y un portafolio
empresarial conectado. Pide verificar nombre, dirección, teléfono, correo y sitio
del negocio, acreditar la relación con él y aportar documentos cuando Meta los
requiera. La verificación precede a App Review. Para revisar la app se necesitan
sus datos básicos, incluida política de privacidad, y demostraciones funcionales.
Fuente: [Become a Tech Provider](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/get-started-for-tech-providers).

| Permiso con acceso avanzado | Función evaluada | Material para la revisión |
| --- | --- | --- |
| `whatsapp_business_messaging` | Mensajería en nombre de clientes. | Explicación escrita y video del envío y su recepción en WhatsApp. |
| `whatsapp_business_management` | Acceso a los WABA y activos de clientes, incluidas plantillas. | Explicación escrita y video de creación de una plantilla. |

La revisión exige explicación y video **por permiso**; una captura estática no
sustituye al video. Meta admite demostraciones mediante API Setup y WhatsApp
Manager, además de una integración propia o con un Solution Partner. Los permisos
de eventos de marketing no son un requisito general de mensajería: la guía los
reserva a su caso de uso. Fuente: [App Review de WhatsApp](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/app-review).

Meta documenta tanto la operación independiente como la colaboración con un
Solution Partner. Solo esta segunda ruta pide el identificador de la app del
partner y crear la solución conjunta. Esta constatación no selecciona una ruta
para IAxTi. Fuente: [onboarding de Tech Providers](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/get-started-for-tech-providers).

Para incorporar clientes, Embedded Signup utiliza Facebook Login for Business y
el SDK JavaScript. Devuelve identificadores WABA/número y un código que se canjea
en servidor. Después se registra el número y se suscribe la app a los webhooks
del WABA. En la ruta independiente, el cliente debe añadir un medio de pago;
compartir una línea de crédito corresponde al caso Solution Partner. La página
anuncia la retirada de Embedded Signup v2 el **15 de octubre de 2026** y remite a
v4. Fuente: [Embedded Signup](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview).

**Inconsistencia registrada:** esa misma página aún vincula el aumento del límite
de onboarding a *Access Verification*, aunque el anuncio del 9 de octubre la
retira y la guía actual de Tech Provider ya no la incluye. No se acredita un
límite efectivo para IAxTi a partir de ese párrafo; ese estado requiere comprobar
el dashboard de la app. No se incorpora el paso obsoleto como requisito vigente.

## Instagram: distinguir las dos rutas de autorización

Ambas rutas sirven cuentas profesionales —negocio o creador—. Para atender cuentas
ajenas sin roles en la app se requieren acceso avanzado, App Review y verificación
del negocio. La aprobación sigue siendo por permisos. Fuente:
[Instagram Platform Overview](https://developers.facebook.com/documentation/instagram-platform/overview).

| Ruta publicada | Cuenta y autorización | Permisos de mensajería que identifica la documentación |
| --- | --- | --- |
| Instagram Login | Cuenta profesional; no requiere vincular una página Facebook. Usa autorización y token de usuario Instagram. | `instagram_business_basic` y `instagram_business_manage_messages`. |
| Facebook Login for Business / Messenger Platform | Cuenta profesional vinculada a página Facebook, con tareas suficientes sobre ella; utiliza la autorización Facebook. | `instagram_basic` e `instagram_manage_messages`, junto con los permisos de página y negocio que requiere Messenger Platform, detallados en la sección siguiente. |

Fuentes: [Instagram Login](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login),
[comparación de rutas](https://developers.facebook.com/documentation/instagram-platform/overview)
y [requisitos de Messenger Platform](https://developers.facebook.com/documentation/business-messaging/messenger-platform/overview).

El nombre `instagram_manage_messages` de la issue corresponde a la ruta Facebook;
no debe copiarse a Instagram Login. Para esta última, los nombres antiguos
`business_*` fueron retirados el 27 de enero de 2025. No se elige aquí qué ruta
implementará IAxTi ni se solicitan permisos de publicación, comentarios o anuncios
por el solo hecho de que existan. Fuente:
[cambio de scopes de Instagram Login](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login).

## Messenger: página, tareas y permisos

La guía vigente requiere cuenta de desarrollador, app con el caso de uso
Messenger y página Facebook vinculada. Para clientes externos se aplican
Business Verification y App Review/acceso avanzado. Para conversaciones, el
inventario publicado mediante Facebook Login for Business es:

- `pages_show_list`, para descubrir las páginas autorizadas;
- `pages_manage_metadata`, `pages_messaging` y `pages_read_engagement`;
- `business_management`, que la guía declara dependencia de permisos de páginas
  y de `instagram_manage_messages` y pide justificar en App Review.

La persona que obtiene el token de página debe poder realizar las tareas
`MESSAGING` y `MODERATE`. Instagram por esta ruta agrega sus dos permisos de la
tabla anterior. Fuente: [Messenger Platform Overview](https://developers.facebook.com/documentation/business-messaging/messenger-platform/overview).

El tutorial de primer envío detalla `pages_show_list` con token de usuario y
`pages_messaging` con token de página; es un ejercicio acotado y no reemplaza el
inventario completo anterior para operar conversaciones de clientes. La respuesta
estándar se envía dentro de las 24 horas siguientes al mensaje recibido; una
aprobación de permisos no elimina esa restricción. Fuente:
[Get Started — Messenger](https://developers.facebook.com/documentation/business-messaging/messenger-platform/get-started).

## Relación con la decisión existente y límites de la entrega

El comentario histórico de la issue describe Kapso y sus escalones/MPS. La
[ADR-0014](../../adr/0014-zavu-como-capa-de-canales.md), aceptada después, eligió
Zavu como transporte del piloto y superó la
[ADR-0005](../../adr/0005-kapso-ahora-tech-provider-despues.md).
[SPEC §12](../../SPEC.md#12-channels--whatsapp--webchat) conserva ese flujo.
La tarifa y las condiciones Kapso del comentario no acreditan una tarifa actual
de Zavu, una solución conjunta disponible para esta cuenta ni una migración de
sus números. Esta investigación no modifica esas decisiones.

| Criterio de #82 | Resultado de esta entrega y pendiente preciso |
| --- | --- |
| 1. Requisitos vigentes | Inventario público contrastado y fechado, con discrepancia oficial explícita. No acredita que IAxTi haya completado los requisitos ni que su dashboard ya refleje todos los cambios. |
| 2. Tiempos reales | Pendiente ejecutar y cronometrar los pasos reales. Una estimación publicada por Meta no sustituye mediciones de IAxTi. |
| 3. Costos comparados | Pendientes tarifas aplicables a la cuenta/proveedor, volúmenes y costos de operar infraestructura, guardia y cumplimiento. No se calculan con datos privados supuestos. |
| 4. Gatillo numérico | Pendiente la decisión sustentada en los costos y volúmenes anteriores; no se introduce un umbral. |
| 5. Migración | Pendiente inventario autorizado de números/clientes y comprobación del recorrido real de salida y re-onboarding. La documentación genérica no acredita una migración Zavu → app propia. |
| 6. ADR que supere 0014 | Pendiente la decisión del responsable con la evidencia completa. La ADR vigente se conserva. |

La parte documental no requirió credenciales. Comprobar estados, presentar
material de revisión, medir aprobaciones y verificar activos concretos sí requiere
acceso autorizado a la app y negocio reales. No se realizaron esas operaciones,
envíos, contactos con proveedores ni modificaciones de producto. **#82 sigue
abierta**; los adaptadores directos continúan fuera de su alcance.

## Verificación reproducible

Se revisaron cuerpo y comentario íntegros de la issue y los documentos del repo
indicados. Las fuentes se obtuvieron con HTTP 200 y quedaron inventariadas en
[fuentes.json](fuentes.json); sus huellas identifican la respuesta consultada, no
garantizan que una descarga futura sea idéntica. El lector web devolvió 429 en
varias páginas y se usó una petición pública ordinaria, sin autenticación.

Validación local: enlaces Markdown relativos y fragmentos, JSON de fuentes y
`git diff --check`. `/module-check` sobre el diff: solo documentación; sin imports,
manifiestos, endpoints, jobs, tools ni migraciones. No se ejecutaron pruebas de
aplicación por este cambio documental ni se atribuye una prueba externa a una
lectura de documentación.
