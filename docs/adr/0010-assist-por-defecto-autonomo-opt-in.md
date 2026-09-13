# ADR 0010 · Modo assist por defecto, autónomo opt-in

**Estado:** aceptada · 2026-09-13

## Contexto
El miedo número uno de la pyme es "el bot va a decir cualquier cosa". Los
competidores prometen bots que venden solos; nuestra diferencia es el control.

## Decisión
El copiloto sugiere y el humano envía (assist), siempre por defecto. El modo
autónomo existe por horario del tenant o marca manual por conversación, nunca
por defecto, y opera dentro de reglas de escalamiento: pide humano, precio/
stock/plazo fuera del conocimiento, enojo o reclamo, N turnos sin avanzar,
dinero sobre el tope, confianza bajo el umbral. Guardrails no negociables:
no inventa precios ni promete lo que una tool no confirmó; no envía iniciados
por el negocio en horario de silencio; toda acción queda explicada en la ficha.

## Consecuencias
- Al 100 % de cuota de IA, autónomo se pausa y todo vuelve a assist con aviso;
  la bandeja nunca se corta.
- Cada respuesta autónoma muestra el nombre del asistente y la opción de pedir
  humano.
- El dataset de evaluación y el LLM-as-judge protegen estos guardrails en cada
  cambio de prompt o modelo.

## Se revisa cuando
Nunca el principio. Los umbrales, por tenant.
