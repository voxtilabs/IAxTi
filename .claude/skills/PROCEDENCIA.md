# De dónde vienen las skills de terceros

`skills-lock.json` tiene el origen y el hash de cada una. Esto agrega lo que un
lock no guarda: **el aviso que la licencia obliga a conservar.**

## kevinrivm/vocero-crm — MIT

```
MIT License · Copyright (c) 2026 Kevin Belier
```

Las dos skills de WhatsApp/Meta salen de ahí:

- `whatsapp-meta-app-review/` — cómo pasar el App Review de Meta: el flujo que
  aprueban, los patrones de rechazo con su causa, y el texto de la
  presentación.
- `whatsapp-saas-meta-infra/` — la capa de infraestructura de un SaaS de
  WhatsApp sobre la Graph API: Embedded Signup, intercambio de token, webhooks,
  esquema y el orden recomendado para construirlo.

**Por qué nos sirven justo ahora:** la ADR-0014 eligió Zavu, entre otras cosas,
para NO pasar por App Review —«semanas de calendario que no controlamos»— y el
proveedor propio sigue siendo el plan de fondo. Estas dos son el mapa de ese
camino, escrito por alguien que ya lo recorrió. No obligan a tomarlo: hacen que
la decisión se tome con el costo a la vista en vez de con una suposición.

La licencia permite usarlas, modificarlas y hasta vender lo que se construya
con ellas, conservando este aviso. Si alguna se modifica, decirlo acá y en la
cabecera del archivo, para que no se le atribuya al autor original algo que
escribimos nosotros.

Vocero CRM es, además, **un competidor directo** de IAxTi: mismo nicho, en
español, gratis y self-hosted. Que su autor publique esto en MIT es su decisión
y la respetamos al pie; conviene saber con qué se está comparando el producto.
