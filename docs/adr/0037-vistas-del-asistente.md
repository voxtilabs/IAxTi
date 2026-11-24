# ADR-0037 · Vistas del asistente: el modelo compone, la pantalla decide

- **Estado:** aceptada
- **Fecha:** 2026-11-23
- **Issue:** #1380
- **Cambia:** nada del SPEC; amplía a ADR-0025 (el asistente responde en la
  conversación) sin tocar su contrato

## Contexto

El Agente General responde en prosa. Cuando la respuesta ES una lista —los
contactos con la ventana abierta, las cifras del mes— la prosa la cuenta pero
no la muestra: números pegados en párrafos, teléfono tras teléfono.

JSON Render (Vercel Labs, `@json-render/*`) propone lo inverso a «la IA genera
interfaz»: un catálogo CERRADO donde cada componente declara sus props con
Zod, la IA solo compone con lo registrado, y quien dibuja es la app. Eso, que
en cualquier producto es una comodidad, acá es una frontera: el SPEC dice que
la IA nunca inventa y nunca toca la base, y un catálogo presentacional lo
cumple por construcción o no pasa.

## La decisión

**La respuesta del asistente puede traer una vista: componentes Mesón que la
web dibuja bajo la prosa.** Un piloto con cinco componentes (`Zona`, `Tabla`,
`Metrica`, `Tarjeta`, `Etiqueta`), sin acciones, sin estado, sin slots.

Cuatro reglas que no se negocian:

1. **Presentacional y literal.** Los schemas solo aceptan strings, números,
   booleanos y arreglos planos. Una expresión (`{$state}`) es un objeto donde
   el schema pide un string: no se puede ni expresar. No hay `on`, `repeat`,
   `visible` ni slots; las acciones siguen pasando por `Propuesta`, que ya va
   por permisos y audit.
2. **Los datos salen de las tools.** La vista presenta lo que una herramienta
   devolvió — que ya pasó por el guard con la identidad de quien conversa.
   La IA arma el layout; no fabrica celdas.
3. **Validación dos veces, con el MISMO catálogo.** El servidor valida antes
   de responder (`extraerVista`) y la web revalida al dibujar
   (`vistaConfiable`), porque el hilo guardado vive en el localStorage del
   navegador y cualquiera lo puede editar a mano. Si algo no valida, la vista
   se descarta y queda la prosa: un piloto roto no puede verse peor que lo
   que ya había.
4. **Cero viajes extra.** La vista viaja en la MISMA respuesta final, como un
   bloque ` ```vista ` al final del texto. Sin segunda llamada, sin streaming
   de UI, sin `useChat`.

**La promesa «presentacional y literal» se cumple en NUESTRO código, no en la
biblioteca.** El `validate` del catálogo no valida los props por componente:
su `propsOf` discrimina cuando el catálogo tiene UN componente y degrada a
`Record<string, unknown>` cuando tiene varios — que es el caso de cualquier
catálogo de verdad. Sin la revalidación por componente de `vistaConfiable`,
un `valor: { $state: "/algo" }` pasaba. La suite lo deja escrito: es la
frontera, y vive en `application/vistas.ts`.

**El estilo no viene de la biblioteca.** `createRenderer` resuelve el árbol;
los componentes que se enchufan son Mesón de siempre (ADR-0034): mono para
teléfonos, montos y fechas — columna por columna si lo pide el modelo, siempre
en la métrica—, superficies y radios de siempre. La IA elige QUÉ mostrar; el
token, la medida y la tipografía los decide esta pantalla y nadie más.

## La entrada `./vistas` del package.json

El contract del módulo es un BARRIL: importarlo arrastra runtime, proveedores
y `pg` — cosas de servidor que el navegador no puede cargar. La web necesita
el catálogo y su revalidación, que solo dependen de `@json-render/core` y
`zod`, y los pide por la entrada `./vistas` del package.json del módulo,
que apunta a esa hoja limpia. `contract.ts` no exporta nada de vistas: quien
lo importe no debe pagar el catálogo por accidente.

Y como `conversacion.tsx` lo importa el popup — que vive en el shell de todas
las páginas—, `VistaDelAgente` se carga con `next/dynamic`: los ~40 kB de
JSON Render bajan cuando aparece la primera vista, no en el First Load de
cada página.

## Consecuencias

- El system prompt del Agente General crece con `INSTRUCCION_DE_VISTA` (~30
  líneas). Un test de deriva exige que cada componente del catálogo aparezca
  en la instrucción: agregar un componente sin contárselo al modelo deja la
  suite rota, y al revés.
- La vista NO vuelve al modelo: `preguntar` le manda solo `{role, content}`.
  El dibujo es para quien conversa, no otra vuelta de tokens.
- El hilo guardado la conserva: `guardarHilo` ya guarda turnos crudos y la
  vista viaja dentro del turno del asistente. Al reabrir, se revalida.
- **Fuera del piloto** (dicho en #1380): la tabla «ventana por vencer»
  necesita una tool que no existe (`conversations` no expone la lista con
  `last_inbound_at`); los gráficos; las vistas en el webchat público.
- El dataset de regresión del agente (#53) corre en CI con su propio secreto;
  sin él, el PR lo dice en el cuerpo y no lo disimula.
