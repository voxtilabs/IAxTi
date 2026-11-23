# ADR-0036 · Un solo plan con todo

- **Estado:** aceptada
- **Fecha:** 2026-11-23
- **Issue:** #1377
- **Cambia:** SPEC §6 (modelo comercial)

## Contexto

SPEC §6 define tres planes —Base, Crece, Equipo— que se diferencian por módulos
y topes. El código lo implementa en serio: `plan_limits` por plan, el guard de
la API deja en `solo_lectura` el módulo que el plan no incluye, y la interfaz
dibuja candados y «Tu plan no incluye esta función».

El dueño del producto decidió el 23-11: *«quiero eliminar por ahora lo de los
planes: simplemente que IAxTi tenga estas cosas, que trae y ya»*. Todavía no hay
clientes pagando por un plan y no otro, y explicar tres planes con candados es
fricción antes de tener a quién cobrársela.

## La decisión

**Un solo plan, `iaxti`, que trae los nueve módulos vendibles.** Todo negocio
vive ahí y todo negocio nuevo nace ahí. La interfaz deja de hablar de planes.

Se eligió sobre arrancar los planes del código:

- **El mecanismo se queda.** `plan_limits`, `modulosDelPlan` y el guard de
  `solo_lectura` siguen. Simplemente nadie queda fuera de nada.
- **Es aditivo y reversible.** La migración agrega una fila y mueve los
  negocios; los planes viejos siguen en la tabla. Volver a vender planes es
  cambiar el plan de los negocios, no reescribir el guard.
- **Respeta la regla de migraciones aditivas** y no reescribe decenas de
  pruebas del guard que siguen siendo verdad.

**Los topes no desaparecen: cambian de propósito.** Dejan de ser comerciales y
quedan como freno de seguridad, con los valores del plan más alto que había
(5 números, 8.000 conversaciones/mes, 12.000 ejecuciones de IA/mes, 200.000
requests de API/mes, retención sin límite). Sin ellos, un negocio o un defecto
podría dejar una cuenta sin techo con el proveedor de IA o con Meta.

## Lo que cambia en el producto

- La prueba vencida sin suscripción ya no baja a Base: no hay a qué bajar. El
  solo lectura por impago sigue igual, porque es por el **estado** de pago, no
  por el plan.
- El SuperAdmin deja de ofrecer cambiar el plan de un negocio: muestra cuál
  tiene.
- Facturación dice «IAxTi completo», no un nombre de plan.

## Lo que NO resuelve

- **No cambia cómo se cobra.** Precio y facturación quedan como estaban.
- **No borra** `plan_limits`, el guard de `solo_lectura`, ni `plan_min` de los
  manifiestos (#834). Si se decide sacar los planes para siempre, es otro ADR
  con su propia migración en dos pasos.

## Cómo se revierte

Cambiar `tenants.plan` de cada negocio al plan que corresponda y volver el
`DEFAULT` de la columna. El guard vuelve a cortar solo; los textos de la
interfaz se restauran desde esta misma PR.
