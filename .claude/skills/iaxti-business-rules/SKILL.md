---
name: iaxti-business-rules
description: Reglas transversales de negocio - ventana 24h, horario de silencio, consentimiento, cuota de IA, ciclo del tenant. Usar al implementar envíos, automatizaciones, agentes, o cualquier flujo que mande mensajes o toque dinero.
---

# Reglas de negocio que el código impone

Fuente: SPEC §8 y `.claude/rules/negocio.md`. Estas reglas se implementan en
la API/colas — la UI las refleja, nunca es la única barrera.

## El embudo de todo envío iniciado por el negocio

Todo mensaje que no es respuesta directa a un cliente pasa, en orden:

1. **Consentimiento**: ¿escribió primero o tiene opt-in registrado? No → no
   sale, se reporta el motivo.
2. **Opt-out**: ¿dijo "BASTA"/"STOP"/equivalente? → opt-out automático, nada
   sale nunca más hasta nuevo opt-in.
3. **Ventana 24 h** (`last_inbound_at`): ¿abierta? libre. ¿cerrada? solo
   plantilla `approved`.
4. **Horario de silencio** (21:00–8:00 defecto): se difiere al siguiente
   horario válido, no se descarta.
5. **Calidad del número**: en `red`, pausado.
6. **Cola outbound**: rate limit por número, reintentos, `failed` legible.

Las respuestas manuales a un cliente que escribió saltan 3 y 4, no 1 y 2.

## Dinero y compromisos de la IA

- Link de pago por IA: hasta el tope configurado y con confirmación, salvo
  regla explícita del tenant.
- La IA nunca afirma agendado/pagado/enviado sin confirmación de la tool.
- Escalamiento (ADR-0010): pide humano, precio/stock/plazo desconocido, enojo,
  N turnos sin avanzar, dinero sobre tope, confianza baja.

## Cuota y ciclo del tenant

- Cuota IA: 80 % avisa; 100 % pausa autónomo (todo vuelve a assist), assist
  puede seguir con modelo barato. La bandeja NUNCA se corta.
- Estados del tenant: trial → active → past_due (7 días gracia) → read_only
  (recibe, no envía salvo manual) → suspended (30 d) → deleted (90 d, con
  exportación ofrecida). Bajar de plan = módulos sobrantes a solo lectura.

Antes del PR: `/rule-check`.
