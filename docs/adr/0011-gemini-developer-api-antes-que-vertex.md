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
> staging está conectado al número real de VoxTi. El 21-09 entró por ahí un
> WhatsApp real.
>
> **Corrección (#593, aterrizada acá el 11-10 por #817).** Esta nota decía
> antes "porque Zavu no ofrece un sandbox: `isTestMode` es propiedad de la
> llave, no del proyecto, así que hay un solo sender y un solo número". Es
> falso: Zavu tiene llaves `zv_test_` de sandbox y una pantalla de números
> verificados. La decisión de usar el número real es **deliberada** —un
> WhatsApp de verdad se comporta distinto que un simulador, y el producto se
> prueba contra lo que va a pasar—, no una limitación del proveedor.
>
> La corrección llegó a `.claude/rules/seguridad.md` cuando se hizo y a este
> ADR no, y eso importa más de lo que parece: este documento es el que citan
> `SECURITY_BASELINE.md` y `COMPLIANCE_BASELINE.md` como autoridad. Quien lo
> abriera para revisar la decisión —la condición 1 de más abajo— se habría
> encontrado con una limitación de proveedor inexistente en vez del riesgo
> deliberado que de verdad hay que pesar, y con la salida de la condición 2
> (`zv_test_`) presentada como imposible. Se sostenía un riesgo aceptado con
> un motivo equivocado, y **un motivo equivocado no se puede revisar**.
>
> O sea que staging **no es** un ambiente sin datos de terceros: es un
> ambiente donde hoy solo escribimos nosotros, pero donde cualquiera que
> tenga el número de VoxTi puede escribir.
>
> Esto se acepta a sabiendas y con dos condiciones:
>
> 1. **Se revisa cuando haya un cliente de verdad.** No "cuando crezcamos":
>    el primer cliente real que atienda por ese número.
> 2. **La salida está identificada**: una llave `zv_test_` de sandbox con un
>    número verificado, un segundo número de prueba, o tier pago en staging.
>    Las tres cuestan algo —plata o dejar de probar contra un WhatsApp de
>    verdad— y por eso hoy no se toma ninguna; el punto es que la decisión
>    sea esa y no el olvido.
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
