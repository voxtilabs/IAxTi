# Matriz de compliance: correcciones factuales de #81

Revisión del 16-10-2026, sobre `staging` en
`79936e77bfa57ebcfbcc16b81888af2fdb9983c7`. Se leyeron el cuerpo y el comentario
completos de [#81](https://github.com/voxtilabs/IAxTi/issues/81). El criterio 1
pide estados reales de implementación; esta revisión corrige afirmaciones
concretas y no certifica cobertura exhaustiva ni cierra la issue.

| Afirmación corregida | Evidencia en la base o en la issue | Límite conservado |
|---|---|---|
| ZAP nunca había corrido | [Comentario del 14-09-2026](https://github.com/voxtilabs/IAxTi/issues/81#issuecomment-5671107709): cuatro corridas; última con 65 pass, 0 fail y 0 warn. El [workflow](../../../.github/workflows/zap.yml) está versionado | Resultado histórico reportado en la issue; no se volvió a escanear staging ni se afirma un resultado actual |
| Semgrep bloqueaba sin distinguir alcance | [CI](../../../.github/workflows/ci.yml) usa `--baseline-commit` y `--error`; sin base válida escanea el árbol completo | Los hallazgos históricos de #758 y sus decisiones siguen pendientes; no se retiró el baseline |
| `redactPII` protegía el audio antes de enviarlo a Google | [models.ts](../../../packages/modules/agents/application/models.ts) envía `audio.bytes` como file part. [runtime.ts](../../../packages/modules/agents/application/runtime.ts) separa el prompt al proveedor de la redacción de la traza | No se declara redacción de voz previa a la transcripción ni se aprueba el contrato de Google |
| El resumen tenía seis proveedores y omitía OpenAI | La propia matriz ya contiene siete filas individuales: Supabase, Gemini, Anthropic, OpenAI, GLM/NVIDIA, Zavu y R2 | Inventario de las filas existentes; no prueba contratos ni añade un proveedor |
| La decisión técnica de GLM seguía sin ADR | [ADR-0023](../../adr/0023-proveedor-economico-glm.md) aceptada y parcialmente supersedida por [ADR-0025 §7](../../adr/0025-el-agente-general.md); [comentario de #54](https://github.com/voxtilabs/IAxTi/issues/54#issuecomment-6110156709) distingue decisión técnica y términos de la cuenta | #54 sigue abierta; términos, retención, entrenamiento y jurisdicción no se dan por revisados |

## Base revisada y cambios pendientes de integración

El comportamiento de audio descrito en esta base corresponde a Google. El
[PR #948](https://github.com/voxtilabs/IAxTi/pull/948), que implementa #864,
añade el puerto de audio de OpenAI y actualiza sus filas de compliance. Se
revisó su commit `009e73fdd42bdf389f5b7f9bb864a882b8ba24f0`, que no pertenece
a la base de este cambio. No se atribuye esa implementación a staging ni se
reemplazan sus filas al integrar ambas ramas.

Lo mismo se aplica a las filas nuevas de consentimiento de Calendar, Drive
y Gmail en los [PR #945](https://github.com/voxtilabs/IAxTi/pull/945),
[#951](https://github.com/voxtilabs/IAxTi/pull/951) y
[#950](https://github.com/voxtilabs/IAxTi/pull/950): pertenecen a esos cambios,
no al código de la base aquí revisada. Sus pruebas locales no acreditan una
cuenta Google/GCP real ni un despliegue.

## Comprobaciones y pendientes

Se contrastaron las referencias locales, los campos de la tabla y el diff
documental. No se ejecutaron tests de producto ni se consultaron cuentas,
datos de clientes, contratos o servicios externos. No hay código, migración,
dependencia, permiso ni política nueva en este cambio.

Se conservan los criterios de #81 sobre derechos del titular, recepción y
efectos externos donde correspondan, y revisión del contrato por abogado.
La evidencia histórica de ZAP no sustituye ninguno de esos criterios.
