# ADR 0011 · Gemini por Developer API antes que Vertex AI

**Estado:** aceptada · 2026-09-13

## Contexto
Vertex AI exige proyecto GCP, IAM y credenciales de servicio antes de que
Terraform exista en el stack. La Developer API da los mismos modelos con una
API key.

## Decisión
Gemini por la Developer API, **tier pago**, con `@ai-sdk/google`. Nunca el tier
gratis: sus condiciones permiten usar los datos para entrenamiento y por aquí
pasan datos de clientes. Modelo por tarea (palanca de costo): Flash para
clasificar, transcribir y sugerir; Pro solo para el configurador. El proveedor
y el modelo se configuran por agente y por tarea, sin deploy.

## Consecuencias
- Cambiar a Vertex AI es cambiar el provider en la configuración del agente.
- El runtime queda multi-proveedor: un modelo económico para tareas de alto
  volumen (candidato GLM) se evalúa en el issue #54 con ADR propio — términos
  de datos, Ley 21.719, redacción de PII y score del dataset de evaluación
  mandan.
- Cuota y costo por tenant se miden por proveedor y modelo.

## Se revisa cuando
Un cliente exija Vertex por residencia o contrato, o el issue #54 concluya.
