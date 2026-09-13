---
name: iaxti-compliance
description: Mantener la matriz de compliance al día. Usar en todo PR que toque datos personales, IA, retención, exportación, consentimiento o proveedores externos.
---

# Compliance de IAxTi

Tres cosas que no se confunden (SPEC §30): preparación técnica (el código),
certificación formal (ISO — proceso aparte, meses) y cumplimiento legal (Ley
21.719). **Jamás se escribe "cumple ISO" en el producto ni en material
comercial**: la arquitectura es "auditable".

## Cuándo actualizar la matriz

`docs/COMPLIANCE_BASELINE.md` tiene una fila por control con
Control · ISO 27001 · 27701 · 42001 · OWASP ASVS · Ley 21.719 ·
Implementación · Tipo (T/O/L/C) · Estado.

Actualiza la fila (o agrega una) cuando el PR:
- toca datos personales (contactos, mensajes, audios, correos, RUT);
- agrega o cambia un flujo de IA (nuevo agente, tool, proveedor, prompt con
  PII);
- cambia retención, borrado, exportación o consentimiento;
- agrega un proveedor que recibe datos (fila de transferencia internacional).

## Los derechos del titular que el código garantiza

- Acceso/portabilidad: exportación total del tenant en un clic.
- Supresión: borrado por solicitud en TODOS los módulos, cualquier plan, con
  registro de la solicitud. Es un flujo distinto de la retención por plan
  (SPEC §39).
- Consentimiento: opt-in con evidencia (fecha, canal); opt-out automático por
  "BASTA"/"STOP".

## Proveedores de IA

Solo tier pago con opt-out de entrenamiento verificado en sus términos
(ADR-0011). Proveedor nuevo (ej. GLM, issue #54) = ADR + fila de transferencia
internacional + redacción de PII en la tubería + corrida del dataset de
evaluación. Sin esos cuatro, no se conecta.
