-- El dólar, con la fecha de SU día (#796).
--
-- `.claude/rules/negocio.md` pide los costos «en pesos», y hoy se muestran en
-- dólares al lado de ingresos en pesos. Un panel que pone $1.240.000 de
-- ingresos arriba y US$12,40 de costo abajo invita a restarlos, y para una
-- pyme chilena eso no es una conversión pendiente: es un margen mal calculado.
--
-- ## Por qué una tabla y no una variable
--
-- Ya hay un tipo de cambio en el entorno (`BILLING_USD_CLP`, con `USD_CLP_RATE`
-- de respaldo) y sirve para FACTURAR el exceso de Meta: es el valor que el
-- negocio acordó, y tiene que ser estable dentro del ciclo. Pero MOSTRAR el
-- costo de un mensaje de marzo con el dólar de hoy mueve el histórico solo cada
-- mañana: el mismo mes rendiría distinto según el día en que se abra el panel.
--
-- Así que el valor se guarda por día, con su fuente, y la conversión usa el
-- dólar DEL DÍA DEL COSTO. Si falta el de ese día, no se convierte con el de
-- otra fecha: se dice que falta. Esa es la tercera condición del issue y es la
-- que hace que el número se pueda defender frente al cliente.
--
-- ## Sin tenant_id, y por qué está bien
--
-- El dólar observado no es de nadie: es el mismo para los 28.000 tenants. Es
-- data de plataforma, como `plan_limits`, así que no lleva `tenant_id` ni
-- política de RLS. Lo que se lee de acá es público —lo publica el Banco
-- Central— y no hay nada que aislar; meterle un `tenant_id` sería guardar
-- 28.000 copias del mismo número y abrir la puerta a que dos tenants vean
-- dólares distintos para el mismo día.
CREATE TABLE IF NOT EXISTS fx_rates (
  -- El par, no solo el valor: el día que haya que mostrar un costo en euros
  -- —o el yuan de un proveedor— esta tabla ya sirve, y la clave no cambia.
  pair   text NOT NULL,
  -- `date` y no `timestamptz`: el dólar observado es de un DÍA, y guardarlo con
  -- hora invita a preguntarse en qué zona, que es la pregunta equivocada.
  day    date NOT NULL,
  -- `numeric` y no `float`: un tipo de cambio se multiplica por dinero.
  value  numeric(12, 4) NOT NULL CHECK (value > 0),
  -- De dónde salió, en palabras. Sin esto, un valor raro no se puede auditar:
  -- es la diferencia entre «el Banco Central dijo esto» y «alguien lo escribió».
  source text NOT NULL,
  PRIMARY KEY (pair, day)
);
