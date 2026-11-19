-- El proveedor por omisión pasa a Zernio (#1339, ADR-0032).
--
-- La columna es de la ADR-0032 y su DEFAULT era `'zavu'` porque en ese
-- momento Zavu era el único adaptador registrado. Ya no lo es: Zavu sale del
-- código y `PROVEEDOR_POR_OMISION` en `domain/port.ts` pasa a `'zernio'`, y
-- este DEFAULT es el mismo compromiso visto desde la base — si dijeran cosas
-- distintas, una cuenta creada sin proveedor explícito y una cuenta leída sin
-- la columna resolverían a adaptadores distintos.
--
-- Aditiva y sin tocar filas: las cuentas que ya declaran `provider` siguen
-- declarando lo mismo. Las desconectadas de Zavu quedan como están (historial,
-- SPEC §39); una cuenta vieja que declare 'zavu' resuelve a «nadie» y el
-- arranque lo avisa, que es el comportamiento correcto para lo que ya no
-- existe. El webchat nunca usó adaptador y su etiqueta heredada no cambia nada.
ALTER TABLE channel_accounts
  ALTER COLUMN provider SET DEFAULT 'zernio';
