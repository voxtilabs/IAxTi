# Regla: testing

- Toda funcionalidad nueva tiene tests que cubren sus criterios de aceptación
  (el Issue los lista; el PR los referencia).
- Pirámide práctica: unit para dominio y casos de uso; integration con
  Postgres y Redis reales (en CI levantados como servicios) para repositorios,
  RLS, colas y webhooks; e2e solo para los flujos que son criterio de salida
  de fase (bandeja desde el celular, onboarding 10 min).
- Tests obligatorios por tipo de cambio:
  - Tabla nueva → test de RLS (tenant A no ve B).
  - Endpoint nuevo → test del guard (sin permiso → 403 formato único) y del
    contrato OpenAPI.
  - Evento nuevo → test de idempotencia del consumidor.
  - `module.yaml` tocado → test de combinación de módulos.
  - Tool de IA nueva → test de que pasa por el guard y de que no borra.
- Cambio de prompt, modelo o proveedor de IA → corre el dataset de regresión
  del agente; no se mergea con score menor a la versión anterior (#53).
- **Un proveedor se mide POR EL PUERTO del producto, nunca con `curl` (#870).**
  «Probé el proveedor» y «probé el producto contra el proveedor» son
  afirmaciones distintas, y solo la segunda dice algo. Lo que eso evita, que
  costó una madrugada y un despliegue roto: #842 declaró OpenAI verificado y
  #863 publicó la tabla de latencias que movió el proveedor por defecto del
  producto entero, y las dos midieron con `curl` armado a mano —mandando el
  parámetro que dice la documentación—. El puerto mandaba otro: el adaptador
  compatible declara el tope como `max_tokens` y `gpt-5` contesta
  `400 · Use 'max_completion_tokens' instead`. Cada llamada moría, con las dos
  mediciones en verde. El mismo concepto tiene TRES nombres según el camino
  —`max_tokens`, `max_completion_tokens`, `max_output_tokens`— y ninguna
  medición de afuera distingue cuál se está usando.
  La guarda que lo sostiene vive en
  `agents/tests/el-cuerpo-que-sale-al-proveedor.test.ts`: intercepta `fetch` y
  mira el cuerpo HTTP de cada proveedor de `PROVIDERS`. Al escribirla, `google`
  y `anthropic` tampoco tenían corrida por el puerto.
- **Una verificación que mira la configuración no verifica la función (#869).**
  «Tiene credencial» no es «funciona»; «el proveedor anda» no es «el producto
  le habla»; «la variable no está vacía» no es ninguna de las dos. Durante tres
  semanas `/ready` dijo `ia ✓` con 51 corridas fallidas y cero exitosas, porque
  las tres verificaciones que existían miraban la configuración, una corrida
  pasada, o `Boolean(process.env[...])`.
  Cuando lo declarado-y-no-aplicado es una **verificación**, el sistema no
  parece roto: parece vigilado, y eso es más difícil de desarmar que una falla
  a secas. Así que toda función que dependa de algo de afuera —un proveedor, un
  canal, un pago— necesita una forma de EJERCITARLA a pedido, no solo de
  describirla. El patrón del repo es `probar-envio` para canales y
  `/agents/probar` para la IA.
- **Leer el código fuente y RENDERIZAR el componente son dos instrumentos
  distintos, y los dos hacen falta (#564).**
  - Una guarda de **fuente** (`*.test.ts` con `fuenteLimpia`) vigila que algo
    declarado en un lado esté aplicado en el otro: que una tabla no tenga
    copias, que no haya hex suelto, que un fallo esté clasificado, que el
    manifiesto no prometa un evento que nadie emite. Es el instrumento del
    defecto más común de este repo y no se reemplaza.
  - Una prueba de **comportamiento** (`*.test.tsx`, con
    `// @vitest-environment jsdom` en la primera línea) monta el componente y
    lo usa. Es el único instrumento para lo que solo se ve al usarlo: que
    arrastrar sobre un hijo no apague el resaltado, que pegar texto siga
    pegando texto, que un envío fallido no borre el borrador.
  - **Cuál usar**: si la pregunta es «¿está escrito?», fuente. Si es «¿qué
    pasa cuando alguien hace esto?», comportamiento. Una guarda de fuente que
    intenta contestar la segunda se vuelve frágil al refactor —cambiar
    `if (await onResponder(` por una variable intermedia la pone roja sin que
    nada se haya roto— y eso enseña a apagarla, que es lo peor que le puede
    pasar a una prueba.
  - El entorno va **por archivo** y no en la configuración: las pruebas de
    fuente no necesitan DOM y montarlo para todas sería pagar su arranque por
    nada. Medido con un archivo vacío: 4,0 s con jsdom contra 3,2 s sin él.
  - `jsdom` y no `happy-dom`, aunque happy-dom arranque ~24 % más rápido: su
    `DataTransfer` no lleva `files`, que es el dato del que dependen las
    pruebas de arrastrar y pegar. Un entorno más rápido que no puede expresar
    el caso no sirve.
  - Costo medido al agregarlas: `apps/web` 330 pruebas en 11,8 s y
    `packages/ui` 84 en 5,9 s. Las de DOM suman ~2 s a cada suite, muy por
    debajo del minuto que obligaría a sacarlas a otro job.
  - Dónde vive la prueba: **junto a la fuente que prueba**. Una prueba de
    `apps/web` sobre un hook de `packages/ui` corre contra su `dist`
    compilado, así que un defecto metido en la fuente la deja verde. Lo
    comprobé escribiéndola en el lugar equivocado primero: inyecté dos
    defectos y pasó las dos veces.
- Los tests usan el seed (#18) como base; datos anonimizados, jamás datos
  reales de clientes en fixtures.
- `/tdd` cuando el criterio de aceptación lo permite: test primero.
- **Toda guarda que escanee código fuente lo escanea LIMPIO** (#569):
  `import { fuenteLimpia } from '@iaxti/core/testing'`. Nunca una copia local con
  expresiones regulares. Lo que eso evita: que la guarda se ponga roja por el
  comentario que la explica —pasó tres veces en una semana, con el hex de un
  `// #548`, con una nota que decía «no importa recharts» y con otra que citaba
  el `Math.log10` borrado— y que un `https://…` dentro de un string se parta al
  medio. Una guarda que grita de más se apaga igual de rápido que una que no
  grita.
- **Una prueba no mide el reloj de la máquina.** Si lo que se prueba depende de
  la hora —horario de silencio, ventana de 24 h, vigencias— se le pasa un
  instante fijo, y el dato de la base se ancla al MISMO instante. Mezclar los dos
  relojes hace que la ventana se mida entre instantes distintos y la prueba pase
  por la razón equivocada. Tres pruebas de #587 se caían con solo correr después
  de las 21:00 en Chile.
