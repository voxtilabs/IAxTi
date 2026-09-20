# Integraciones pendientes: orden y riesgo · revisión 20/09/2026

Esta revisión corresponde a los adicionales solicitados después del lote
#346, #297, #356, #298, #299, #300 y la corrección de CI #363. Un PR con
pruebas locales no acredita que su proveedor esté operativo en staging.

| Issue | Criticidad de un fallo | Trabajo verificable / condición pendiente |
|---|---|---|
| #361 entrada de canales | Alta: mensajes de clientes perdidos | Obtener excepción real y reproducir primero. No encolar sin firma ni atribuir la causa al pooler sin evidencia. Separar corrección de fallo y recepción durable si resulta necesaria. |
| #360 contrato frontend/API | Baja: guarda de desarrollo | PR #367: impedir rutas inexistentes mediante análisis de AST y ejecución en CI sin caché. No requiere proveedor. |
| #60 pagos | Alta: cobros y destino de credenciales | Protección separada #366: validar modo/destino oficial, ejemplos vacíos y no seguir redirecciones. La integración completa requiere Flow Sandbox real de punta a punta. |
| #57 Google Calendar | Alta: ofrecer horarios incorrectos | OAuth incremental, tokens custodiados, free/busy real, push y auditoría. Una variable ficticia no acredita disponibilidad. Resolver antes de anunciar agenda conectada a Google. |
| #64 Drive → #65 Gmail | Alta: acceso a documentos/correo | Drive primero; scopes mínimos, revocación y auditoría. Gmail depende de #64. Se necesitan configuración OAuth y pruebas autorizadas con el proveedor. |
| #59 recordatorios | Alta: envíos duplicados o citas marcadas sin aviso | El emisor del worker aún necesita transporte/plantilla real. Revisar entrega e idempotencia antes de habilitarlo; no sustituirlo por un éxito simulado. |
| #74 Instagram/Messenger | Alta: recepción/envío y ventanas de canal | Validación con cuentas reales de Zavu antes del lanzamiento; compartir adaptador no acredita reglas y entrega real en cada canal. |
| #54 proveedor LLM económico | Alta: datos de clientes y comportamiento de IA | Decisión del dueño, términos del proveedor y evaluación comparativa real pendientes. No activar por una llave de ejemplo ni inventar resultados de evaluación. |
| #17 observabilidad, #254 staging | Alta: disponibilidad/diagnóstico | Configuración y evidencia de operación en Kuma/Grafana/Dokploy. El código no reemplaza acceso al despliegue. |
| #113 acceso por correo, #56 onboarding real | Alta para completar el recorrido del usuario | Validar entrega/autenticación real y recorrido cronometrado con número conectado. Las pruebas locales no cierran esos criterios. |

Los defaults admisibles son configuración sin efectos externos (por ejemplo,
URL sandbox) y valores vacíos. Las credenciales ilustrativas se documentan,
no se cargan ni activan automáticamente. La ausencia de credenciales debe
bloquear esa operación con un error comprensible y permitir que el resto
de la aplicación siga funcionando.

Las issues superiores permanecen abiertas cuando falta un criterio real del
proveedor. Las protecciones se entregan en PR separados con su propia issue,
pruebas y revisión; no se cuentan como integraciones completas.
