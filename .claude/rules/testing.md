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
