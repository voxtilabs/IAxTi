-- Zavu sale del despliegue (#1339, ADR-0032): cada fila queda con el nombre de
-- QUIÉN la atiende de verdad, y la etiqueta «zavu» deja de existir como valor
-- vivo.
--
-- Dos verdades distintas se arreglan acá, y cada una con su herramienta:
--
-- 1) Las cuentas de webchat y simulador NUNCA fueron de Zavu. La columna
--    `provider` las etiquetó así porque el `DEFAULT` de la migración 0006 era
--    ese y nadie lo declaraba, y funcionaban por la coincidencia de que el
--    adaptador correspondiente también registraba bajo el por-omisión. Con
--    Zavu fuera, esa etiqueta apunta a un proveedor que ya no existe. Se
--    repuntan a su proveedor real: `webchat` y `simulador`, que es lo que sus
--    adaptadores declaran desde #1339.
-- 2) Las cuentas de WhatsApp (y las de Instagram/Messenger de #74) que sí
--    pasaron por Zavu NO se repuntan: «zavu» es su historia y mentirles un
--    proveedor que nunca las atendió es peor que el dato viejo. Están
--    desconectadas —el corte de la épica #1338 las archiva— y su etiqueta
--    resuelve a «nadie», que es lo correcto para un canal muerto: el webhook
--    lo dice con `sin_proveedor` y el diagnóstico manda a reconectar.
--
-- Lo que esa etiqueta histórica NO podía seguir haciendo es tumbar el
-- arranque: `proveedores_de_cuentas()` contaba TODAS las filas, y una base con
-- historia de Zavu se habría vuelto imposible de levantar el día que su
-- adaptador dejó de registrarse. La verificación existe para cuentas que
-- pueden MANDAR — «una cuenta que declara un proveedor sin adaptador no
-- tiene por dónde mandar» —, y una desconectada no manda nada. Se acota a
-- `state <> 'disconnected'`: lo archivado es historia, no un riesgo de
-- enrutamiento.
--
-- Aditiva de verdad: no toca tablas ni columnas, solo datos y una función que
-- ya existía (mismo nombre, mismas grants —`CREATE OR REPLACE` las conserva—).
-- El rollback es de imagen: la función vieja sigue en la 0006.
UPDATE channel_accounts
   SET provider = 'webchat', updated_at = now()
 WHERE kind = 'webchat' AND provider <> 'webchat';

UPDATE channel_accounts
   SET provider = 'simulador', updated_at = now()
 WHERE kind = 'simulador' AND provider <> 'simulador';

-- La verificación del arranque (migración 0006) solo mira cuentas que pueden
-- mandar. Ver el comentario de arriba: la etiqueta de lo desconectado no es
-- un proveedor huérfano, es un registro.
CREATE OR REPLACE FUNCTION proveedores_de_cuentas()
RETURNS SETOF text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT provider FROM channel_accounts
   WHERE state <> 'disconnected'
   ORDER BY 1
$$;
