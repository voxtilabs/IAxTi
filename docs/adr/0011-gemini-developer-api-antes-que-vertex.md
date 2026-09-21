# ADR 0011 · Gemini por Developer API antes que Vertex AI

**Estado:** aceptada · 2026-09-13

## Contexto
Vertex AI exige proyecto GCP, IAM y credenciales de servicio antes de que
Terraform exista en el stack. La Developer API da los mismos modelos con una
API key.

## Decisión
Gemini por la Developer API con `@ai-sdk/google`. **Tier pago allí donde pasan
datos de clientes.**

> **Enmienda del 21-09-2026 (Lino).** La versión original decía "nunca el tier
> gratis", sin matices, y eso dejaba el asistente apagado en staging mientras
> no hubiera saldo — con el costo de no poder probar el producto.
>
> El motivo de la regla no es el precio: es que las condiciones del tier
> gratis permiten usar los datos para entrenamiento. Ese motivo aplica donde
> hay datos de clientes, y **en staging no los hay**: solo pruebas nuestras.
>
> Queda así:
>
> | Ambiente | Tier | Por qué |
> |---|---|---|
> | staging | gratis | Solo datos de prueba. Nadie real pasa por ahí. |
> | producción | **pago** | Conversaciones reales de clientes de nuestros clientes. |
>
> **Y acá hay una incomodidad que conviene escribir, no esconder.** La regla
> del proyecto dice "nunca un número real de WhatsApp en staging", y hoy
> staging está conectado al número real de VoxTi — porque Zavu no ofrece un
> sandbox: `isTestMode` es propiedad de la llave, no del proyecto, así que
> hay un solo sender y un solo número. El 21-09 entró por ahí un WhatsApp
> real.
>
> O sea que staging **no es** un ambiente sin datos de terceros: es un
> ambiente donde hoy solo escribimos nosotros, pero donde cualquiera que
> tenga el número de VoxTi puede escribir.
>
> Esto se acepta a sabiendas y con dos condiciones:
>
> 1. **Se revisa cuando haya un cliente de verdad.** No "cuando crezcamos":
>    el primer cliente real que atienda por ese número.
> 2. **La salida está identificada**: un segundo número de prueba en Zavu, o
>    tier pago en staging. Cuesta plata, y por eso hoy no se toma; el punto
>    es que la decisión sea esa y no el olvido.
>
> Mientras tanto, lo que pasa por el modelo en staging son mensajes de
> prueba nuestros. Si eso cambia, cambia la decisión. Modelo por tarea (palanca de costo): Flash para
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
